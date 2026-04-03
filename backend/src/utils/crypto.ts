import crypto from 'crypto';

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
 * Encrypt a plain-text string. Returns a base64-encoded string
 * containing iv + authTag + ciphertext.
 *
 * If CREDENTIALS_ENCRYPTION_KEY is not set, returns the input unchanged
 * (dev-mode passthrough).
 */
export function encryptCredentials(plaintext: string): string {
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
    console.warn('[crypto] Encrypted credentials found but CREDENTIALS_ENCRYPTION_KEY is not set — cannot decrypt');
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
