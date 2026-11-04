/**
 * API-key encryption for at-rest storage — pure JS, no WebCrypto/btoa (the
 * tgcloud V8 isolate exposes none of that; crypto.getRandomValues is available).
 *
 * v2 format — `v2:<base64(iv || ciphertext)>`:
 *   • per-install random 32-byte secret (crypto.getRandomValues), generated on
 *     first use and persisted in the `config` table — unlike the old scheme,
 *     nothing required to decrypt is derivable from PUBLIC data (tgId was in
 *     URLs and the salt was in this repo).
 *   • random 12-byte IV per encryption → ciphertexts differ even for the same key.
 *
 * Legacy format — plain hex (FNV-1a keystream over public salt + tgId):
 *   read-only fallback so keys stored before v2 keep working. New writes are
 *   always v2; once all rows have been re-saved through the UI they can go.
 */

import { db } from 'sdk';
import { eq } from 'sdk/db';
import { config } from 'schema';

const SECRET_ROW = 'enc_secret';
let cachedSecret = null;

// ─── FNV-1a 32-bit — fingerprints (chat dedup) & legacy keystream ─────────────
function fnv1a32(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 16777619) >>> 0; // force unsigned 32-bit
  }
  return hash;
}

/**
 * Stable fingerprint of a chat message for duplicate suppression
 * (chat_claims): the Mini App may re-send a `chat` action that outlived its
 * client timeout — same text within a few seconds = same logical request.
 */
export function fingerprint(text) {
  return `${fnv1a32(String(text))}-${String(text).length}`;
}

// ─── Pure helpers (no Buffer/btoa) ───────────────────────────────────────────

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes) {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64_CHARS[(n >> 18) & 63];
    out += B64_CHARS[(n >> 12) & 63];
    out += i + 1 < len ? B64_CHARS[(n >> 6) & 63] : '=';
    out += i + 2 < len ? B64_CHARS[n & 63] : '=';
  }
  return out;
}

function fromBase64(str) {
  const clean = String(str).replace(/[^A-Za-z0-9+/]/g, '');
  const bytes = [];
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64_CHARS.indexOf(clean[i]);
    const b = B64_CHARS.indexOf(clean[i + 1]);
    const c = clean[i + 2] === '=' ? -1 : B64_CHARS.indexOf(clean[i + 2]);
    const d = clean[i + 3] === '=' ? -1 : B64_CHARS.indexOf(clean[i + 3]);
    bytes.push((a << 2) | (b >> 4));
    if (c >= 0) bytes.push(((b & 15) << 4) | (c >> 2));
    if (d >= 0) bytes.push(((c & 3) << 6) | d);
  }
  return new Uint8Array(bytes);
}

function toHex(bytes) {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}

function utf8Encode(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const low = str.charCodeAt(++i);
      code = 0x10000 + ((code & 0x3ff) << 10) + (low & 0x3ff);
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

function utf8Decode(bytes) {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if ((b0 & 0xe0) === 0xc0) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if ((b0 & 0xf0) === 0xe0) {
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      out += String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
    } else {
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      let cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}

/**
 * Pure JS base64 decode to UTF-8 string (tgcloud V8 isolate has no Buffer / atob).
 */
export function base64DecodeString(str) {
  try {
    if (!str || typeof str !== 'string') return '';
    const bytes = fromBase64(str);
    return utf8Decode(bytes);
  } catch {
    return '';
  }
}

function randBytes(n) {
  const b = new Uint8Array(n);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    return crypto.getRandomValues(b);
  }
  for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
}

// ─── Per-install secret (v2) ─────────────────────────────────────────────────

async function getSecret() {
  if (cachedSecret) return cachedSecret;
  let row = await db.select().from(config).where(eq(config.key, SECRET_ROW)).get();
  if (!row) {
    const secret = toBase64(randBytes(32));
    await db.insert(config).values({ key: SECRET_ROW, value: secret })
      .onConflictDoNothing()
      .run();
    row = await db.select().from(config).where(eq(config.key, SECRET_ROW)).get();
    if (!row) row = { value: secret }; // lost a creation race — use ours
  }
  cachedSecret = row.value;
  return cachedSecret;
}

// Keyed stream: XOR with a keystream expanded from secret+IV (same mixer as
// ai-bot's importer — proven in production there).
function keystream(secretBytes, iv, len) {
  const out = new Uint8Array(len);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let h3 = 0xdeadbeef;
  let h4 = 0x41c6ce57;
  for (let i = 0; i < iv.length; i++) {
    h1 ^= iv[i];
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  for (let i = 0; i < secretBytes.length; i++) {
    h2 ^= secretBytes[i];
    h2 = Math.imul(h2, 0x01000193) >>> 0;
    h3 ^= secretBytes[(i * 7) % secretBytes.length];
    h3 = Math.imul(h3, 0x85ebca6b) >>> 0;
  }
  for (let i = 0; i < len; i++) {
    h1 ^= h2 >>> (i % 32);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= h3;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    h3 ^= h4;
    h3 = Math.imul(h3, 0xc2b2ae35) >>> 0;
    h4 ^= h1;
    h4 = Math.imul(h4, 0x27d4eb2f) >>> 0;
    out[i] = (h1 ^ h2 ^ h3 ^ h4) & 0xff;
  }
  return out;
}

// ─── Legacy v1 (public salt + tgId) — READ ONLY ─────────────────────────────

const LEGACY_SALT = 'NineRouter_K3y_S@lt_v1';

function* legacyKeystream(seed) {
  let state = fnv1a32(String(seed));
  while (true) {
    yield (state >>> 24) & 0xff;
    yield (state >>> 16) & 0xff;
    yield (state >>> 8) & 0xff;
    yield state & 0xff;
    state = fnv1a32(String(state));
  }
}

function legacyDecrypt(cipherHex, tgId) {
  const gen = legacyKeystream(`${LEGACY_SALT}:${tgId}`);
  const cipherBytes = fromHex(cipherHex);
  let result = '';
  for (const byte of cipherBytes) {
    result += String.fromCharCode(byte ^ gen.next().value);
  }
  return result;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext API key (v2, async — needs the per-install secret).
 * `tgId` kept for call-site compatibility; it no longer feeds the key material.
 */
export async function encryptKey(plaintext, tgId) {
  if (!plaintext) return null;
  const secret = await getSecret();
  const secretBytes = fromBase64(secret);
  const iv = randBytes(12);
  const plainBytes = utf8Encode(String(plaintext));
  const ks = keystream(secretBytes, iv, plainBytes.length);
  const out = new Uint8Array(12 + plainBytes.length);
  out.set(iv, 0);
  for (let i = 0; i < plainBytes.length; i++) out[12 + i] = plainBytes[i] ^ ks[i];
  return `v2:${toBase64(out)}`;
}

/**
 * Decrypt a stored key. Handles both formats:
 *   `v2:...` → random secret + IV; anything else hex → legacy v1 (needs tgId).
 */
export async function decryptKey(cipher, tgId) {
  if (!cipher || typeof cipher !== 'string') return '';
  if (cipher.startsWith('v2:')) {
    try {
      const data = fromBase64(cipher.slice(3));
      if (data.length < 13) return '';
      const iv = data.slice(0, 12);
      const ct = data.slice(12);
      const secret = await getSecret();
      const ks = keystream(fromBase64(secret), iv, ct.length);
      const pt = new Uint8Array(ct.length);
      for (let i = 0; i < ct.length; i++) pt[i] = ct[i] ^ ks[i];
      return utf8Decode(pt);
    } catch {
      return '';
    }
  }
  try {
    return legacyDecrypt(cipher, tgId);
  } catch {
    return '';
  }
}

/**
 * Mask an API key for display (show first 6 + last 4 chars).
 */
export function maskKey(plaintext) {
  if (!plaintext || plaintext.length < 12) return '••••••••';
  return `${plaintext.slice(0, 6)}••••${plaintext.slice(-4)}`;
}

/**
 * Pure-JS Uint8Array to base64 encoder (tgcloud: no btoa/Buffer).
 */
export function uint8ToBase64(bytes) {
  if (!bytes || bytes.length === 0) return '';
  return toBase64(bytes);
}