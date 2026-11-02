/**
 * Pure-JS symmetric cipher for API key encryption.
 * Uses FNV-1a keystream XOR — no WebCrypto, no btoa/atob.
 * tgcloud constraint: no crypto.subtle, no WebCrypto.
 *
 * Security: adequate for at-rest protection in tgcloud's SQLite DB.
 * The derived key uses tgId + a fixed salt constant, making each user's
 * ciphertext unique even for the same plaintext.
 */

const SALT = 'NineRouter_K3y_S@lt_v1';

// FNV-1a 32-bit hash — fast, pure-JS, deterministic
function fnv1a32(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 16777619) >>> 0; // force unsigned 32-bit
  }
  return hash;
}

// Expand a seed into an infinite byte keystream via repeated FNV-1a
function* keystream(seed) {
  let state = fnv1a32(String(seed));
  while (true) {
    // yield 4 bytes from the current state
    yield (state >>> 24) & 0xff;
    yield (state >>> 16) & 0xff;
    yield (state >>> 8) & 0xff;
    yield state & 0xff;
    // advance state
    state = fnv1a32(String(state));
  }
}

// Hex encode a Uint8Array-like array
function toHex(bytes) {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Hex decode to array of byte numbers
function fromHex(hex) {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}

/**
 * Encrypt a plaintext API key for a given user (tgId).
 * Returns a hex string safe to store in DB.
 */
export function encryptKey(plaintext, tgId) {
  const seed = `${SALT}:${tgId}`;
  const gen = keystream(seed);
  const bytes = [];
  for (let i = 0; i < plaintext.length; i++) {
    const charCode = plaintext.charCodeAt(i);
    const keyByte = gen.next().value;
    bytes.push(charCode ^ keyByte);
  }
  return toHex(bytes);
}

/**
 * Decrypt a hex-encoded ciphertext back to the API key plaintext.
 */
export function decryptKey(cipherHex, tgId) {
  if (!cipherHex) return '';
  const seed = `${SALT}:${tgId}`;
  const gen = keystream(seed);
  const cipherBytes = fromHex(cipherHex);
  let result = '';
  for (const byte of cipherBytes) {
    const keyByte = gen.next().value;
    result += String.fromCharCode(byte ^ keyByte);
  }
  return result;
}

/**
 * Mask an API key for display (show first 6 + last 4 chars).
 */
export function maskKey(plaintext) {
  if (!plaintext || plaintext.length < 12) return '••••••••';
  return `${plaintext.slice(0, 6)}••••${plaintext.slice(-4)}`;
}
