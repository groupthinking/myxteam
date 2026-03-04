/**
 * OAuth 1.0a Signature Generation for X API
 *
 * Implements the HMAC-SHA1 signature scheme required by X API v2 when using
 * OAuth 1.0a credentials (Consumer Key + Access Token + Secrets).
 *
 * This is needed when the X app is configured with "Read and Write" OAuth 1.0a
 * permissions in the developer portal. OAuth 2.0 Bearer Token is used for
 * app-only requests (Filtered Stream), while OAuth 1.0a is used for
 * user-context requests (posting, replying, deleting).
 *
 * Reference: https://developer.x.com/en/docs/authentication/oauth-1-0a
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OAuth1Credentials {
  /** OAuth 1.0a Consumer Key (API Key) from the X Developer Portal. */
  consumerKey: string;
  /** OAuth 1.0a Consumer Secret (API Secret) from the X Developer Portal. */
  consumerSecret: string;
  /** OAuth 1.0a Access Token for the specific user/agent account. */
  accessToken: string;
  /** OAuth 1.0a Access Token Secret for the specific user/agent account. */
  accessTokenSecret: string;
}

// ─── OAuth 1.0a Header Generation ────────────────────────────────────────────

/**
 * Generate an OAuth 1.0a Authorization header for a given request.
 *
 * @param method  HTTP method (GET, POST, DELETE, etc.)
 * @param url     Full request URL (without query string for POST requests)
 * @param creds   OAuth 1.0a credentials
 * @param bodyParams  For POST requests with application/x-www-form-urlencoded body,
 *                    include body params here. For JSON bodies, leave empty.
 * @returns       The Authorization header value (starts with "OAuth ")
 */
export function buildOAuth1Header(
  method: string,
  url: string,
  creds: OAuth1Credentials,
  bodyParams?: Record<string, string>,
): string {
  // Generate a random nonce (alphanumeric, 32 chars)
  const nonce = generateNonce();
  const timestamp = String(Math.floor(Date.now() / 1000));

  // Base OAuth parameters (always included in signature)
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  // Combine all parameters for signature base string
  // For JSON bodies, bodyParams is empty — only oauth params are signed
  const allParams: Record<string, string> = { ...oauthParams, ...bodyParams };

  // Build the signature base string
  const sigBase = buildSignatureBaseString(method, url, allParams);

  // Build the signing key
  const signingKey = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.accessTokenSecret)}`;

  // Compute HMAC-SHA1 signature
  const signature = hmacSha1Base64(signingKey, sigBase);
  oauthParams["oauth_signature"] = signature;

  // Build the Authorization header value
  const headerParts = Object.entries(oauthParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(", ");

  return `OAuth ${headerParts}`;
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Build the OAuth 1.0a signature base string.
 * Format: METHOD&encoded_url&encoded_params
 */
function buildSignatureBaseString(
  method: string,
  url: string,
  params: Record<string, string>,
): string {
  // Sort and encode parameters
  const sortedParams = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`)
    .join("&");

  return [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(sortedParams),
  ].join("&");
}

/**
 * Percent-encode a string per RFC 3986.
 * More aggressive than encodeURIComponent — also encodes !, ', (, ), *
 */
function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => {
    return "%" + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

/**
 * Generate a random alphanumeric nonce string.
 */
function generateNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  // Use crypto.getRandomValues if available (Node 19+, browsers), else Math.random
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      result += chars[byte % chars.length];
    }
  } else {
    for (let i = 0; i < 32; i++) {
      result += chars[Math.floor(Math.random() * chars.length)];
    }
  }
  return result;
}

/**
 * Compute HMAC-SHA1 and return as base64.
 *
 * Uses the Web Crypto API (available in Node.js 15+ and all modern browsers).
 * Falls back to a pure-JS implementation for environments without crypto.
 */
async function hmacSha1Base64Async(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(message),
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

/**
 * Synchronous HMAC-SHA1 wrapper.
 * Since Web Crypto is async, we use a synchronous fallback here.
 * This is intentionally simple — for production use the async version.
 *
 * Note: This function returns a placeholder that is replaced by the async
 * version in buildOAuth1Header. The sync version is kept for test compatibility.
 */
function hmacSha1Base64(key: string, message: string): string {
  // Pure-JS HMAC-SHA1 implementation (no native crypto dependency)
  // Based on RFC 2104 and SHA-1 (FIPS PUB 180-4)
  return computeHmacSha1(key, message);
}

/**
 * Pure-JS SHA-1 implementation for HMAC computation.
 * Used as a synchronous fallback when Web Crypto is not available.
 */
function computeHmacSha1(key: string, message: string): string {
  const BLOCK_SIZE = 64;

  // Convert string to byte array
  function strToBytes(s: string): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code < 128) {
        bytes.push(code);
      } else if (code < 2048) {
        bytes.push((code >> 6) | 192, (code & 63) | 128);
      } else {
        bytes.push((code >> 12) | 224, ((code >> 6) & 63) | 128, (code & 63) | 128);
      }
    }
    return bytes;
  }

  // SHA-1 implementation
  function sha1(msgBytes: number[]): number[] {
    // Pre-processing: adding padding bits
    const msgLen = msgBytes.length;
    msgBytes.push(0x80);
    while (msgBytes.length % 64 !== 56) msgBytes.push(0);
    // Append original length in bits as 64-bit big-endian
    const bitLen = msgLen * 8;
    for (let i = 7; i >= 0; i--) {
      msgBytes.push((bitLen / Math.pow(2, i * 8)) & 0xff);
    }

    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;

    for (let i = 0; i < msgBytes.length; i += 64) {
      const w: number[] = [];
      for (let j = 0; j < 16; j++) {
        w[j] = (msgBytes[i + j * 4] << 24) | (msgBytes[i + j * 4 + 1] << 16) |
                (msgBytes[i + j * 4 + 2] << 8) | msgBytes[i + j * 4 + 3];
      }
      for (let j = 16; j < 80; j++) {
        const n = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
        w[j] = ((n << 1) | (n >>> 31)) >>> 0;
      }

      let a = h0, b = h1, c = h2, d = h3, e = h4;

      for (let j = 0; j < 80; j++) {
        let f: number, k: number;
        if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
        else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
        else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
        else { f = b ^ c ^ d; k = 0xca62c1d6; }

        const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) >>> 0;
        e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = temp;
      }

      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0;
      h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }

    return [
      (h0 >> 24) & 0xff, (h0 >> 16) & 0xff, (h0 >> 8) & 0xff, h0 & 0xff,
      (h1 >> 24) & 0xff, (h1 >> 16) & 0xff, (h1 >> 8) & 0xff, h1 & 0xff,
      (h2 >> 24) & 0xff, (h2 >> 16) & 0xff, (h2 >> 8) & 0xff, h2 & 0xff,
      (h3 >> 24) & 0xff, (h3 >> 16) & 0xff, (h3 >> 8) & 0xff, h3 & 0xff,
      (h4 >> 24) & 0xff, (h4 >> 16) & 0xff, (h4 >> 8) & 0xff, h4 & 0xff,
    ];
  }

  const keyBytes = strToBytes(key);
  const msgBytes = strToBytes(message);

  // Normalize key to block size
  let keyPad = keyBytes.length > BLOCK_SIZE ? sha1(keyBytes) : keyBytes;
  while (keyPad.length < BLOCK_SIZE) keyPad.push(0);

  // HMAC: H((K XOR opad) || H((K XOR ipad) || message))
  const ipad = keyPad.map((b) => b ^ 0x36);
  const opad = keyPad.map((b) => b ^ 0x5c);

  const innerHash = sha1([...ipad, ...msgBytes]);
  const outerHash = sha1([...opad, ...innerHash]);

  // Convert to base64
  return btoa(String.fromCharCode(...outerHash));
}

/**
 * Async version of buildOAuth1Header using Web Crypto for better performance.
 * Use this in production code paths where async is acceptable.
 */
export async function buildOAuth1HeaderAsync(
  method: string,
  url: string,
  creds: OAuth1Credentials,
  bodyParams?: Record<string, string>,
): Promise<string> {
  const nonce = generateNonce();
  const timestamp = String(Math.floor(Date.now() / 1000));

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  const allParams: Record<string, string> = { ...oauthParams, ...bodyParams };
  const sigBase = buildSignatureBaseString(method, url, allParams);
  const signingKey = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.accessTokenSecret)}`;

  let signature: string;
  if (typeof globalThis.crypto?.subtle !== "undefined") {
    signature = await hmacSha1Base64Async(signingKey, sigBase);
  } else {
    signature = hmacSha1Base64(signingKey, sigBase);
  }

  oauthParams["oauth_signature"] = signature;

  const headerParts = Object.entries(oauthParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(", ");

  return `OAuth ${headerParts}`;
}
