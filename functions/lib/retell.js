/* Shug — Retell webhook signature verification.

   Reimplements retell-sdk's verify() against the Web Crypto API so Pages
   Functions need no npm dependency. Transcribed from the SDK source
   (retell-sdk@5.64.0, src/lib/webhook_auth.ts) rather than from prose docs,
   because every detail below is load-bearing:

     header:     X-Retell-Signature
     format:     v={unix_ms_timestamp},d={64 hex chars}
     signed:     rawBody + timestamp        <- string concatenation, the
                                               timestamp exactly as it appeared
                                               in the header
     key:        the Retell API key, raw UTF-8 bytes
     algorithm:  HMAC-SHA256
     tolerance:  |now - timestamp| <= 5 minutes, absolute (future OR past)

   Only the API key carrying the webhook badge in the Retell dashboard can
   verify webhooks. If verification fails for every request, check that first.

   This module exports no onRequest* handler, so Pages adds no route for it. */

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const SHA_256_HEX_LENGTH = 64;
const SIGNATURE_PATTERN = /^v=(\d+),d=([0-9a-f]+)$/i;

export const SIGNATURE_HEADER = 'x-retell-signature';

function hexToBytes(hex) {
  if (hex.length !== SHA_256_HEX_LENGTH || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = new Uint8Array(SHA_256_HEX_LENGTH / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/* crypto.subtle.verify does the comparison in constant time, which is why this
   verifies the digest rather than recomputing a hex string and using ===. */
export async function verifySignature(rawBody, apiKey, signature, options) {
  if (typeof rawBody !== 'string' || typeof apiKey !== 'string' || !apiKey) return false;
  if (typeof signature !== 'string') return false;

  const match = SIGNATURE_PATTERN.exec(signature);
  if (!match) return false;

  const poststamp = Number(match[1]);
  const digest = hexToBytes(match[2]);
  const now = (options && options.timestamp) || Date.now();
  const tolerance = (options && options.tolerance) || FIVE_MINUTES_MS;

  if (!Number.isSafeInteger(poststamp) || !digest) return false;
  if (Math.abs(now - poststamp) > tolerance) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(apiKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  return crypto.subtle.verify(
    'HMAC',
    key,
    digest,
    new TextEncoder().encode(rawBody + poststamp)
  );
}

/* Reads the raw body ONCE and verifies against those exact bytes.

   The raw text must never be re-serialised before verification — JSON.parse
   followed by JSON.stringify can reorder keys or change whitespace, and the
   digest is over the bytes Retell actually sent. Callers get both the parsed
   object and the verification result from here so there is no path through the
   code that parses first and verifies second.

   Returns: { ok, status, code, body, raw }
   `body` is only populated when ok is true. */
export async function readVerifiedWebhook(request, apiKey, options) {
  const required = !(options && options.optional === true);

  const signature = request.headers.get(SIGNATURE_HEADER);
  const raw = await request.text();

  if (!apiKey) {
    /* Fail closed. An unset key must never mean "skip the check". */
    console.error('retell: RETELL_API_KEY is not configured — rejecting webhook');
    return { ok: false, status: 500, code: 'not_configured', raw: raw };
  }

  if (!signature) {
    if (required) {
      console.warn('retell: webhook rejected — no ' + SIGNATURE_HEADER + ' header');
      return { ok: false, status: 401, code: 'unsigned', raw: raw };
    }
    console.warn('retell: unsigned request accepted — signature not required on this route');
  } else {
    const valid = await verifySignature(raw, apiKey, signature, options);
    if (!valid) {
      /* Never log the signature or the body: one is an oracle, the other may
         carry a transcript. The timestamp is safe and is what identifies a
         clock-skew problem versus a genuinely bad key. */
      console.warn('retell: webhook rejected — signature did not verify');
      return { ok: false, status: 401, code: 'bad_signature', raw: raw };
    }
  }

  let body = null;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return { ok: false, status: 400, code: 'malformed_json', raw: raw };
  }

  if (!body || typeof body !== 'object') {
    return { ok: false, status: 400, code: 'malformed_json', raw: raw };
  }

  return { ok: true, status: 200, code: null, body: body, raw: raw };
}
