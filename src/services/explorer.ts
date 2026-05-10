/**
 * Thin HTTP client for the audit page.
 *
 * Matches the wire shapes wallet-lib's `txApi` and `walletApi` use,
 * but doesn't go through wallet-lib's `createRequestInstance` because
 * that one is configured against the wallet's currently-selected
 * network. The audit page lets the user pick a network at runtime,
 * so each request needs an explicit base URL.
 *
 * Two endpoints in use:
 *   - `POST /thin_wallet/address_history`  (paginated by `hash`
 *     cursor) — bulk-fetches the tx ids that touched any of the
 *     supplied addresses.
 *   - `GET  /transaction?id=<hash>`  — full tx body, including the
 *     post-decryption `shielded_outputs[]` shape we need for rewind.
 *
 * Both responses go through wallet-lib's `transformJsonBigIntResponse`
 * + the `transactionApiSchema` / `addressHistorySchema` so we
 * inherit the same Zod validation (and the relaxed `mode` / `token_data`
 * gates we shipped in 0.0.8-shielded for legacy fullnodes).
 */

import axios from 'axios';
// Deep imports: wallet-lib's main `lib/index.js` namespace doesn't
// re-export these schemas. Same stability tradeoff as the
// `shieldedAddress` import in services/keys.ts — exact version pin
// in package.json bounds the blast radius.
import { transformJsonBigIntResponse } from '@hathor/wallet-lib/lib/utils/bigint';
import { transactionApiSchema } from '@hathor/wallet-lib/lib/api/schemas/txApi';

import type { Network } from './networks';

/**
 * Schema for `/thin_wallet/address_history`. Defining locally rather
 * than importing wallet-lib's `addressHistorySchema` because the
 * audit page only needs `tx_id` for cursor-walking + dedup; reading
 * the rest of the response would just bloat the bundle.
 */
export interface AddressHistoryEntry {
  tx_id: string;
  // Other fields (timestamp, balance, etc.) are present on the wire
  // but we re-fetch the full tx for everything we need. Not parsing
  // them keeps this lean.
}

export interface AddressHistoryResponse {
  success: boolean;
  history: AddressHistoryEntry[];
  /** Pagination cursor; absent when the page is the last. */
  has_more?: boolean;
  first_hash?: string;
  first_address?: string;
}

/**
 * One page of address history. Pass the returned `nextCursor` back
 * in the next call to continue. `null` means no more pages.
 *
 * Uses GET (matching wallet-lib's `getAddressHistory` at
 * `src/api/wallet.ts:37`) — the testnet fullnode rejects the POST
 * variant with 403, even though wallet-lib has a POST method too.
 * The GET form is fine for ≤50 addresses (well under typical URL
 * limits), and our gap-limit sweep batches 20 at a time.
 */
export async function getAddressHistory(
  network: Network,
  addresses: string[],
  cursor: { hash: string; address: string } | null
): Promise<{ entries: AddressHistoryEntry[]; nextCursor: { hash: string; address: string } | null }> {
  const params: { addresses: string[]; paginate: boolean; hash?: string; address?: string } = {
    // Pass the array directly — axios's default paramsSerializer emits
    // `?addresses[]=A&addresses[]=B`, which is what the fullnode's
    // `thin_wallet/address_history` endpoint requires (it returns
    // "Missing parameter: addresses[]" on any other shape). Wallet-lib's
    // `getAddressHistoryForAwait` does the same — no custom serializer
    // in `axiosWrapper.ts`, so we inherit identical behavior here.
    addresses,
    paginate: true,
  };
  if (cursor) {
    params.hash = cursor.hash;
    params.address = cursor.address;
  }
  const resp = await axios.get<AddressHistoryResponse>(
    `${network.fullnodeUrl}thin_wallet/address_history`,
    { params }
  );
  if (!resp.data.success) {
    throw new Error('address_history request failed');
  }
  const entries = resp.data.history ?? [];
  let nextCursor: { hash: string; address: string } | null = null;
  if (resp.data.has_more && resp.data.first_hash && resp.data.first_address) {
    nextCursor = { hash: resp.data.first_hash, address: resp.data.first_address };
  }
  return { entries, nextCursor };
}

/**
 * Fetch a single tx by id. Validates against wallet-lib's Zod schema
 * (the same one the explorer uses), so a malformed response throws
 * here rather than crashing rendering downstream.
 *
 * Returns the parsed `tx` body — `txData.tx` in wallet-lib's
 * envelope, but we unwrap it before returning since the audit
 * orchestrator only needs the inner record.
 */
export async function getTransaction(network: Network, txId: string): Promise<unknown> {
  const resp = await axios.get(`${network.fullnodeUrl}transaction`, {
    params: { id: txId },
    transformResponse: res => transformJsonBigIntResponse(res, transactionApiSchema),
  });
  // The schema's discriminated union resolves to `{success: true, tx, meta, ...}` on success.
  if (!resp.data?.success) {
    throw new Error(`transaction lookup failed: ${resp.data?.message ?? 'unknown error'}`);
  }
  return resp.data.tx;
}

/**
 * Build the explorer URL for a given tx, optionally with the
 * unblinding payload embedded as a fragment. Keeping the
 * fragment-build close to the explorer call site so the two stay
 * in lockstep — the explorer's parser at
 * `hathor-explorer/src/utils/unblinding.js` expects exactly this
 * `#unblind=<base64url>` shape.
 */
export function buildExplorerLink(
  network: Network,
  txId: string,
  payloadBase64Url: string | null
): string {
  const base = `${network.explorerUrl}transaction/${txId}`;
  return payloadBase64Url ? `${base}#unblind=${payloadBase64Url}` : base;
}
