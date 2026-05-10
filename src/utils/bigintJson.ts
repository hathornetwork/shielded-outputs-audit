/**
 * Encode/decode the unblinding payload envelope for the explorer's
 * URL fragment.
 *
 * Mirrors the format the mobile wallet emits in
 * `hathor-wallet-mobile/src/components/AuditUnblindingRows.js` — the
 * explorer's parser at `hathor-explorer/src/utils/unblinding.js`
 * speaks exactly this shape, so the audit page must produce it
 * byte-for-byte.
 *
 * Schema (v=1):
 *   {
 *     v: 1,
 *     txId: <hex>,
 *     outputs: [{index, value: <stringified bigint>, token, vbf, abf?}, ...],
 *     inputs?:  [{index, value: <stringified bigint>, token, vbf, abf?}, ...],
 *   }
 */

export interface OpeningEntry {
  index: number;
  value: bigint;
  token: string;
  vbf: string;
  abf?: string;
}

export function encodeUnblindingPayload(
  txId: string,
  outputs: OpeningEntry[],
  inputs: OpeningEntry[]
): string | null {
  if (outputs.length === 0 && inputs.length === 0) return null;
  const envelope = {
    v: 1,
    txId,
    outputs: outputs.map(encodeEntry),
    // Match the wallet's wire form — only emit `inputs` when non-empty
    // so existing v=1 explorers (which made `inputs` optional) parse
    // identically for output-only payloads.
    ...(inputs.length > 0 ? { inputs: inputs.map(encodeEntry) } : {}),
  };
  return base64url(JSON.stringify(envelope));
}

function encodeEntry(e: OpeningEntry) {
  return {
    index: e.index,
    value: e.value.toString(),
    token: e.token,
    vbf: e.vbf,
    ...(e.abf ? { abf: e.abf } : {}),
  };
}

/**
 * URL-fragment-safe base64 (RFC 4648 §5): replace `+` with `-`,
 * `/` with `_`, strip padding `=`. Matches the encoding the mobile
 * wallet uses; the explorer's parser strips the same way.
 */
function base64url(str: string): string {
  // Buffer is provided by `vite-plugin-node-polyfills` in the dev/
  // build bundle; declared as a global there.
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Convert a wire string → Uint8Array for the wasm-bindgen surface.
 *
 * The fullnode emits shielded-output fields in mixed encodings — a
 * hathor-core quirk where `commitment` and `ephemeral_pubkey` come
 * out as lowercase hex but `range_proof`, `script`, `asset_commitment`
 * and `surjection_proof` come out as base64 (compare two fields side-
 * by-side in `/v1a/transaction?id=…` to see it). Wallet-lib normalizes
 * via `ensureHex` in `utils/transaction.ts:211` during tx ingestion;
 * the audit reads the raw fullnode response without going through
 * that pipeline, so we re-implement the same hex-or-base64 detection
 * here.
 *
 * Detection: pure `[0-9a-fA-F]` → hex; anything else → base64. Idem-
 * potent on already-hex inputs and matches `ensureHex` byte-for-byte.
 */
export function hexToBytes(input: string): Uint8Array {
  const clean = input.startsWith('0x') ? input.slice(2) : input;
  if (clean.length === 0) return new Uint8Array(0);
  if (/^[0-9a-fA-F]+$/.test(clean)) {
    if (clean.length % 2 !== 0) {
      throw new Error('hex string must have even length');
    }
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  // Base64 path. `Buffer` is provided by `vite-plugin-node-polyfills`
  // — the same path the rest of this module uses for base64url
  // encoding, so we don't pull in a separate decoder.
  const buf = Buffer.from(clean, 'base64');
  const out = new Uint8Array(buf.length);
  out.set(buf);
  return out;
}

/** Convert Uint8Array → hex (lowercase, no `0x` prefix). */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}
