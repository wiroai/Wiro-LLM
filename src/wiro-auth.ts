/**
 * A Wiro project credential: the API key alone for an API Key Only project,
 * or `API_KEY:API_SECRET` for a Signature project.
 */
export interface WiroCredential {
  apiKey: string;
  apiSecret?: string;
}

/**
 * Splits a credential at its first colon. The part before it is the API key
 * and the part after it, when there is one, is the API secret.
 */
export function splitCredential(credential: string): WiroCredential {
  const value = credential.trim();
  const colon = value.indexOf(':');
  if (colon === -1) return { apiKey: value };
  const apiKey = value.slice(0, colon).trim();
  const apiSecret = value.slice(colon + 1).trim();
  return apiSecret ? { apiKey, apiSecret } : { apiKey };
}

let lastNonce = 0;

/**
 * The nonce for one signed request: the time in milliseconds, raised by one
 * when two requests are signed in the same millisecond, so no two match.
 */
function nextNonce(): string {
  lastNonce = Math.max(Date.now(), lastNonce + 1);
  return String(lastNonce);
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

/**
 * The headers that authenticate one Run API request. A Signature project
 * signs every request with a fresh nonce:
 * `x-signature = HMAC-SHA256(key: API_KEY, message: API_SECRET + nonce)`.
 */
export async function runApiAuthHeaders(credential: string): Promise<Record<string, string>> {
  const { apiKey, apiSecret } = splitCredential(credential);
  if (!apiSecret) return { 'x-api-key': apiKey };
  const nonce = nextNonce();
  return {
    'x-api-key': apiKey,
    'x-nonce': nonce,
    'x-signature': await hmacSha256Hex(apiKey, apiSecret + nonce),
  };
}
