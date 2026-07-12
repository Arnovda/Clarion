import crypto from 'crypto';
import { logger as rootLogger } from './logger';

const log = rootLogger.child({ mod: 'crypto' });

/**
 * AES-256-GCM encryption for connection credentials at rest.
 *
 * The encryption key is derived from the CREDENTIALS_ENCRYPTION_KEY env var.
 * If the key is not set, encrypt/decrypt are no-ops (for backwards compatibility
 * in development). In production, this key MUST be set.
 *
 * Format: base64(iv:authTag:ciphertext)
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer | null {
  const envKey = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!envKey) return null;
  // Derive a 32-byte key from the env value using SHA-256
  return crypto.createHash('sha256').update(envKey).digest();
}

/**
 * Production guard: refuse to encrypt-as-noop when the key is missing.
 * In dev, returning plaintext is convenient (no key setup). In prod,
 * silently storing connection credentials in plaintext is a real risk
 * that wouldn't surface until someone reads the database — by which
 * time the damage is done. Hard-fail at first write instead.
 */
function ensureKeyOrFail(operation: 'encrypt' | 'decrypt'): void {
  if (process.env.NODE_ENV === 'production' && !getKey()) {
    throw new Error(
      `CREDENTIALS_ENCRYPTION_KEY is not set in production. ` +
      `Refusing to ${operation} credentials. ` +
      `Provide a random ≥32-byte key via the env var or Key Vault.`,
    );
  }
}

/**
 * Encrypt a plain-text string. Returns a base64-encoded string
 * containing iv + authTag + ciphertext.
 *
 * In development with CREDENTIALS_ENCRYPTION_KEY unset, returns the
 * input unchanged (passthrough — convenient for local dev). In
 * production, refuses to passthrough and throws.
 */
export function encryptCredentials(plaintext: string): string {
  ensureKeyOrFail('encrypt');
  const key = getKey();
  if (!key) return plaintext;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack: iv + authTag + ciphertext → base64
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return `enc:${packed.toString('base64')}`;
}

/**
 * Decrypt a value produced by encryptCredentials().
 *
 * If the value doesn't start with 'enc:', it's treated as unencrypted
 * (backwards compatibility).
 */
export function decryptCredentials(value: string): string {
  if (!value.startsWith('enc:')) return value;

  const key = getKey();
  if (!key) {
    log.warn('Encrypted credentials found but CREDENTIALS_ENCRYPTION_KEY is not set — cannot decrypt');
    throw new Error('Cannot decrypt credentials: encryption key not configured');
  }

  const packed = Buffer.from(value.slice(4), 'base64');
  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

/**
 * Check if a config string is already encrypted.
 */
export function isEncrypted(value: string): boolean {
  return value.startsWith('enc:');
}
