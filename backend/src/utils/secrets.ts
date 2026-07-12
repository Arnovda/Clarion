/**
 * Secrets management — abstraction over Azure Key Vault and local env vars.
 *
 * In development: reads from process.env (dotenv).
 * In production on Azure: reads from Azure Key Vault, with env vars as fallback.
 *
 * Usage:
 *   const apiKey = await getSecret('ANTHROPIC_API_KEY');
 */

import { logger as rootLogger } from './logger';

const log = rootLogger.child({ mod: 'secrets' });

// ---------------------------------------------------------------------------
// Cache to avoid repeated Key Vault calls
// ---------------------------------------------------------------------------

const cache = new Map<string, string>();

/**
 * Get a secret by name.
 * First checks Key Vault (if configured), then falls back to process.env.
 */
export async function getSecret(name: string): Promise<string | undefined> {
  // Check cache
  if (cache.has(name)) return cache.get(name);

  // Try Azure Key Vault if configured
  const vaultUrl = process.env.AZURE_KEY_VAULT_URL;
  if (vaultUrl) {
    try {
      const value = await getFromKeyVault(vaultUrl, name);
      if (value !== undefined) {
        cache.set(name, value);
        return value;
      }
    } catch (err) {
      log.warn({ err }, `Key Vault lookup failed for "${name}"`);
      // Fall through to env var
    }
  }

  // Fallback to environment variable
  const envValue = process.env[name];
  if (envValue !== undefined) {
    cache.set(name, envValue);
  }
  return envValue;
}

/**
 * Pre-load a list of secrets into cache at startup.
 * Avoids per-request latency for frequently used secrets.
 */
export async function preloadSecrets(names: string[]): Promise<void> {
  const vaultUrl = process.env.AZURE_KEY_VAULT_URL;
  if (!vaultUrl) {
    // No Key Vault — everything comes from env, no preload needed
    return;
  }

  log.info(`Pre-loading ${names.length} secrets from Key Vault…`);
  const results = await Promise.allSettled(names.map((n) => getSecret(n)));
  const loaded = results.filter((r) => r.status === 'fulfilled' && r.value !== undefined).length;
  log.info(`Loaded ${loaded}/${names.length} secrets`);
}

/**
 * Clear the secrets cache. Useful for rotation.
 */
export function clearSecretsCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Key Vault client (lazy-loaded)
// ---------------------------------------------------------------------------

async function getFromKeyVault(vaultUrl: string, secretName: string): Promise<string | undefined> {
  // Dynamic import — only loaded when Key Vault is actually used
  const { SecretClient } = await import('@azure/keyvault-secrets');
  const { DefaultAzureCredential } = await import('@azure/identity');

  const credential = new DefaultAzureCredential();
  const client = new SecretClient(vaultUrl, credential);

  // Key Vault secret names use hyphens, not underscores
  const kvName = secretName.replace(/_/g, '-').toLowerCase();

  try {
    const secret = await client.getSecret(kvName);
    return secret.value;
  } catch (err: unknown) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404) return undefined; // Secret not found — fall back to env
    throw err;
  }
}
