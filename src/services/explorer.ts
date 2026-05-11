/**
 * Thin HTTP client for the audit page.
 *
 * Matches the wire shapes wallet-lib's `walletApi` uses, but doesn't
 * go through wallet-lib's `createRequestInstance` because that one is
 * configured against the wallet's currently-selected network. The
 * audit page lets the user pick a network at runtime, so each request
 * needs an explicit base URL.
 *
 * Only one endpoint is in use:
 *
 *   - `GET /thin_wallet/address_history`  (paginated by `hash` cursor)
 *     bulk-fetches the full tx bodies that touched any of the supplied
 *     addresses, including shielded entries inline in `outputs[]` /
 *     `inputs[]` discriminated by `type === 'shielded'`. That's all
 *     the audit needs — the standalone `GET /transaction?id=<hash>`
 *     endpoint we used earlier was redundant.
 *
 * No Zod validation here: the audit page validates the bits it
 * consumes ad-hoc, and pulling in `addressHistorySchema` would force
 * `transformJsonBigIntResponse` into the path (the schema uses bigint
 * coercions) without buying us anything we couldn't do with a typed
 * cast — output values aren't summed at any single bigint precision
 * boundary in this app.
 */

import axios from 'axios';

import type { Network } from './networks';

/**
 * One transparent output entry as the fullnode emits it. Same shape
 * as wallet-lib's `IHistoryOutput` minus the fields the audit doesn't
 * read. `value` is `string | number` on the wire (the fullnode emits
 * it un-coerced); the audit converts to bigint at the call site.
 */
export interface RawTransparentOutput {
  value: string | number | bigint;
  script: string;
  token?: string;
  token_data: number;
  decoded?: { type?: string; address?: string; timelock?: number | null };
  spent_by?: string | null;
}

/**
 * One inline shielded output entry. Discriminated by `type === 'shielded'`
 * in the parent `outputs[]` array. All crypto byte fields may be hex
 * or base64 on the wire — see `hexToBytes` in `utils/bigintJson.ts`
 * for the detection logic (mirrors wallet-lib's `ensureHex`).
 */
export interface RawShieldedOutput {
  type: 'shielded';
  script: string;
  commitment: string;
  range_proof: string;
  ephemeral_pubkey: string;
  /** Present only for FullShielded outputs (mode 2). */
  asset_commitment?: string;
  /** Present only for FullShielded outputs (mode 2). */
  surjection_proof?: string;
  /** Optional on the wire; defaults to 0 (HTR) for AmountShielded. */
  token_data?: number;
  /** Optional on the wire; absent in pre-mode-field hathor-core nodes. */
  mode?: number;
  decoded?: { address?: string };
  spent_by?: string | null;
}

export type RawOutput = RawTransparentOutput | RawShieldedOutput;

export interface RawTransparentInput {
  value: string | number | bigint;
  script: string;
  tx_id: string;
  index: number;
  token?: string;
  token_data?: number;
}

export interface RawShieldedInput {
  type: 'shielded';
  script: string;
  tx_id: string;
  index: number;
  commitment: string;
}

export type RawInput = RawTransparentInput | RawShieldedInput;

/**
 * One transaction as it appears in the `history[]` array returned by
 * `/thin_wallet/address_history`. Shielded outputs / inputs are inline
 * in `outputs[]` / `inputs[]` discriminated by `type === 'shielded'` —
 * the audit splits them locally (see `splitShieldedFromHistoryTx` in
 * `services/audit.ts`).
 */
export interface RawTx {
  tx_id: string;
  version: number;
  timestamp: number;
  is_voided: boolean;
  inputs: RawInput[];
  outputs: RawOutput[];
  tokens?: ({ uid: string; name?: string; symbol?: string } | string)[];
  parents?: string[];
  first_block?: string | null;
}

interface AddressHistoryResponse {
  success: boolean;
  history: RawTx[];
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
 * variant with 403. The GET form is fine for ≤50 addresses (well
 * under typical URL limits), and our gap-limit sweep batches 20 at a
 * time.
 */
export async function getAddressHistory(
  network: Network,
  addresses: string[],
  cursor: { hash: string; address: string } | null
): Promise<{ entries: RawTx[]; nextCursor: { hash: string; address: string } | null }> {
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

interface TokenInfoResponse {
  success: boolean;
  name?: string;
  symbol?: string;
  message?: string;
}

/**
 * Fetch a single token's name + symbol from the fullnode.
 *
 * `address_history` returns `tokens` as a bare array of UIDs (just
 * hex strings) — the standalone `/transaction?id=…` shape included
 * `{uid, name, symbol}` objects, but the list endpoint omits
 * metadata to keep responses small. The audit needs the symbols to
 * populate the token-selector dropdown, so we fetch each unique UID
 * separately via this endpoint. Mirrors wallet-lib's
 * `walletApi.getGeneralTokenInfo` at `src/api/wallet.ts:147`.
 *
 * Returns `null` when the lookup fails — the caller renders the bare
 * UID prefix as a fallback so the dropdown never loses an entry.
 */
export async function getTokenInfo(
  network: Network,
  uid: string
): Promise<{ name: string; symbol: string } | null> {
  try {
    const resp = await axios.get<TokenInfoResponse>(`${network.fullnodeUrl}thin_wallet/token`, {
      params: { id: uid },
    });
    if (!resp.data?.success || !resp.data.symbol || !resp.data.name) return null;
    return { name: resp.data.name, symbol: resp.data.symbol };
  } catch {
    return null;
  }
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
