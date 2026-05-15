/**
 * Audit orchestrator. Runs the full pipeline:
 *
 *   form input → derive addresses → sweep tx history (full bodies in
 *   one endpoint) → rewind every owned shielded output → build per-tx
 *   unblinding payloads → return display rows.
 *
 * Pure async — no UI dependencies. The form component calls this
 * once on submit, awaits the rows, then renders.
 *
 * The design deliberately stops short of being a "wallet". No
 * persistence, no websocket, no balance reconciliation across runs.
 * Every audit pass is a fresh full sync of the addresses' history.
 *
 * `address_history` returns full tx bodies (including shielded
 * entries inline in `outputs[]` and `inputs[]` discriminated by
 * `type === 'shielded'`), so we don't need a follow-up
 * `/transaction?id=…` round-trip per tx — that single change cut the
 * wall-clock time of a 100-tx audit from ~30s to ~3s. Mirrors what
 * wallet-lib's `HathorWallet` sync does in `utils/storage.ts:217` →
 * `utils/transaction.ts:normalizeShieldedOutputs` (case (a)).
 */

import init, * as wasm from '@hathor/ct-crypto-wasm';

import {
  checkAsymmetricDerivationPairs,
  deriveScanPrivkey,
  deriveSpendAddress,
  validateAuditKeys,
} from './keys';
import {
  buildExplorerLink,
  getAddressHistory,
  getTokenInfo,
  type RawOutput,
  type RawShieldedOutput,
  type RawTx,
} from './explorer';
import type { Network } from './networks';
import {
  bytesToHex,
  encodeUnblindingPayload,
  hexToBytes,
  type OpeningEntry,
} from '../utils/bigintJson';

/** BIP44-style sliding gap-limit. Same default the standard wallet uses. */
const GAP_LIMIT = 20;
/** Hard cap so a misbehaving fullnode can't loop us forever. */
const MAX_ADDRESSES = 2000;
/** Native token UID convention (32 zero bytes, hex string `'00'` on the wire). */
const NATIVE_TOKEN_UID_HEX = '0'.repeat(64);

export interface DisplayRow {
  txId: string;
  /** Unix timestamp in seconds, as the fullnode reports it. */
  timestamp: number;
  /** Per-token net balance: positive = received, negative = sent. */
  balance: { tokenUid: string; tokenSymbol: string; delta: bigint }[];
  /** True if the wallet appears as recipient or spender of any shielded output. */
  hasShieldedActivity: boolean;
  /** True if the wallet appears as recipient or spender of any transparent output. */
  hasTransparentActivity: boolean;
  /** Direct link to the explorer; includes `#unblind=…` when openings are available. */
  explorerLink: string;
}

/** Token surfaced in the wallet's history, plus HTR (hardcoded). */
export interface TokenInfo {
  /** 32-byte UID as lowercase hex. HTR uses 64 zero chars; never the legacy `'00'`. */
  tokenUid: string;
  /** Display symbol. Falls back to a short hash prefix for tokens with no metadata. */
  symbol: string;
  /** Display name. Same fallback as symbol. */
  name: string;
}

/**
 * Public + private balance pair for a single token.
 *
 * `publicBalance` covers transparent activity at the wallet's
 * derived addresses (received minus sent). `privateBalance` covers
 * the shielded outputs we rewound + the inputs whose parent output
 * the wallet owned. Either can be zero.
 */
export interface TokenBalance {
  tokenUid: string;
  publicBalance: bigint;
  privateBalance: bigint;
}

export interface AuditResult {
  rows: DisplayRow[];
  /** Tokens encountered in the wallet's history, plus HTR (always first). */
  tokens: TokenInfo[];
  /** Per-token public + private balance pair. Keyed by `tokenUid`. */
  balances: Record<string, TokenBalance>;
}

export interface AuditProgress {
  // Phases the orchestrator emits onProgress for:
  //   - 'history': address-history sweep (and the token-metadata
  //                fetch sub-step, which reuses the same phase id
  //                with a swapped message).
  //   - 'rewind':  the WASM range-proof rewind pass.
  //   - 'done':    terminal state.
  // WASM init and address derivation finish in ~100ms combined, fast
  // enough that surfacing dedicated phases for them only adds
  // visible flicker — `App.tsx` seeds 'history' as the initial state
  // and the orchestrator overrides it as soon as the sweep starts.
  phase: 'history' | 'rewind' | 'done';
  current?: number;
  total?: number;
  message?: string;
}

export interface AuditInput {
  network: Network;
  spendXpub: string;
  scanXpriv: string;
}

/**
 * Run the audit. Optional `onProgress` callback fires at each phase
 * boundary so the UI can show a progress indicator instead of a
 * blank screen during the (potentially slow) tx-fetch phase.
 */
export async function runAudit(
  input: AuditInput,
  onProgress?: (p: AuditProgress) => void
): Promise<AuditResult> {
  validateAuditKeys(input.spendXpub, input.scanXpriv);

  // wasm-pack `--target web` ships an `init()` default export that
  // fetches the .wasm and instantiates it. Idempotent — calling
  // twice is a no-op. We deliberately don't surface a separate
  // "loading verifier" progress message: WASM init takes ~100ms on
  // a warm cache, address derivation is microseconds of BIP32 math,
  // and the user-perceived first phase is the address-history sweep
  // anyway. Skipping both keeps the running view from flashing two
  // intermediate states before settling.
  await init();

  // --- 1. Derive addresses with a sliding gap-limit window ----------
  // Same algorithm the standard wallet uses on first sync: keep a
  // tail of `GAP_LIMIT` addresses; whenever any address inside that
  // tail gets a tx hit, slide forward by `GAP_LIMIT` more. Stop
  // once the tail is fully empty (or we hit the safety cap).
  const addressToIndex = new Map<string, number>();
  const allAddresses: string[] = [];
  // Address → set of tx_ids it appears in. Used for the gap-limit
  // termination condition (any tail address with hits = keep going).
  const addressHits = new Map<string, Set<string>>();

  /**
   * Derive `count` more addresses starting from `nextIndex` and
   * register them. Returns the inclusive last index added.
   */
  const deriveBatch = (start: number, count: number): number => {
    for (let i = 0; i < count; i += 1) {
      const idx = start + i;
      if (idx >= MAX_ADDRESSES) break;
      const address = deriveSpendAddress(
        input.spendXpub,
        input.scanXpriv,
        idx,
        input.network.network
      );
      addressToIndex.set(address, idx);
      allAddresses.push(address);
      addressHits.set(address, new Set());
    }
    return Math.min(start + count - 1, MAX_ADDRESSES - 1);
  };

  let nextIndex = 0;
  deriveBatch(nextIndex, GAP_LIMIT);
  nextIndex += GAP_LIMIT;

  // One-time pairing self-check at index 0. If the user's keys land
  // in the ~1/256 region where bitcore-lib's compliant vs non-
  // compliant child derivation diverge, every rewind would silently
  // fail — log the mismatch so it shows up in the same console block
  // as the per-output rewind warnings.
  const pairCheck = checkAsymmetricDerivationPairs(input.scanXpriv, 0);
  // eslint-disable-next-line no-console
  console.info(
    `[audit] keypair self-check at idx 0: ${pairCheck.matches ? 'OK' : 'MISMATCH'}\n` +
      `  privkey-derived pub: ${pairCheck.privkeyPub}\n` +
      `  address-encoded pub: ${pairCheck.addressPub}`
  );

  // --- 2. Address-history sweep + gap-limit extension --------------
  // Each `address_history` response carries the full tx body —
  // including shielded outputs / inputs inline in `outputs[]` /
  // `inputs[]` — so the sweep doubles as the body-fetch step. We
  // build a deduplicated `txs` map keyed by tx_id along the way; the
  // same tx may show up under multiple of the wallet's addresses
  // (sender + recipient, change splits, etc.) and we only need it
  // once.
  onProgress?.({ phase: 'history', message: 'Loading address history…' });
  const txs: Record<string, FullNodeTx> = {};
  let cursor = 0; // Index of the next address we still need to query.

  // Sweep loop: run history for any address we haven't queried yet,
  // then check the tail. Extend if any tail-address has hits.
  for (;;) {
    const batch = allAddresses.slice(cursor);
    if (batch.length === 0) {
      // All currently-derived addresses queried; check the gap.
    } else {
      let pageCursor: { hash: string; address: string } | null = null;
      do {
        const { entries, nextCursor } = await getAddressHistory(
          input.network,
          batch,
          pageCursor
        );
        for (const e of entries) {
          // Voided txs (consensus-rejected) still appear in
          // `address_history` because they once touched the
          // address. Wallet-lib filters them at `processSingleTx`
          // (`utils/storage.ts:888`) and skips all downstream work;
          // the audit must do the same — otherwise voided outputs
          // would inflate balances and surface tokens that don't
          // really exist. Gap-limit hit registration still fires so
          // address derivation matches wallet behavior for chains
          // that contain voided activity.
          for (const addr of batch) addressHits.get(addr)!.add(e.tx_id);
          if (e.is_voided) continue;
          // First time we see this tx — split its shielded entries
          // out of the mixed `outputs[]` / `inputs[]` arrays so the
          // downstream rewind + balance logic can treat shielded
          // and transparent as separate streams (matches the shape
          // the standalone `/transaction?id=…` endpoint emits and
          // what wallet-lib stores after `normalizeShieldedOutputs`).
          if (!txs[e.tx_id]) {
            txs[e.tx_id] = splitShieldedFromHistoryTx(e);
          }
        }
        pageCursor = nextCursor;
      } while (pageCursor !== null);
      cursor = allAddresses.length;
    }

    // Tail = last GAP_LIMIT derived addresses. If any of them have
    // hits, derive another GAP_LIMIT batch and loop. Otherwise stop.
    const tail = allAddresses.slice(-GAP_LIMIT);
    const tailHasHits = tail.some(addr => (addressHits.get(addr)?.size ?? 0) > 0);
    if (!tailHasHits) break;
    if (nextIndex >= MAX_ADDRESSES) break;
    deriveBatch(nextIndex, GAP_LIMIT);
    nextIndex += GAP_LIMIT;
  }

  // --- 3. Rewind every owned shielded output -----------------------
  // Build a global map keyed by `<txId>:<onChainOutputIndex>` so
  // step 5 can look up shielded INPUTs (which reference parent-tx
  // outputs) in O(1).
  onProgress?.({ phase: 'rewind', message: 'Rewinding shielded outputs…' });
  const ownedOpenings = new Map<string, OpeningEntry>();
  // Counters for the post-loop diagnostic summary. Without these,
  // a "0 rewound openings" outcome is indistinguishable between
  // "no shielded outputs are addressed to this wallet" and "the
  // rewind primitive is rejecting every input" — and the difference
  // matters for debugging.
  let totalShieldedOutputs = 0;
  let shieldedOutputsAddressedToWallet = 0;
  let rewindFailures = 0;
  // One-shot deep diagnostic for the first owned shielded output:
  // dumps the exact bytes we pass to the WASM rewind primitive plus
  // the ECDH shared secret it derives. If derivations are correct
  // but rewind still fails, this surfaces whether the issue is in
  // input shape, ECDH, or downstream range-proof verification.
  let deepDumpDone = false;
  for (const [txId, tx] of Object.entries(txs)) {
    const transparentCount = tx.outputs?.length ?? 0;
    const shieldedOutputs = tx.shielded_outputs ?? [];
    for (let s = 0; s < shieldedOutputs.length; s += 1) {
      const slot = shieldedOutputs[s];
      totalShieldedOutputs += 1;
      const recipientAddress = slot.decoded?.address;
      if (!recipientAddress) continue;
      const addressIndex = addressToIndex.get(recipientAddress);
      if (addressIndex === undefined) continue; // Not addressed to this audit's wallet
      shieldedOutputsAddressedToWallet += 1;
      const onChainIndex = transparentCount + s;

      const scanPrivkey = deriveScanPrivkey(input.scanXpriv, addressIndex);
      const ephPk = hexToBytes(slot.ephemeral_pubkey);
      const commitment = hexToBytes(slot.commitment);
      const rangeProof = hexToBytes(slot.range_proof);
      const isFullShielded = slot.mode === 2 || !!slot.asset_commitment;

      if (!deepDumpDone) {
        deepDumpDone = true;
        // We don't log the scan privkey itself — the keypair self-check
        // already proved it pairs with the address-encoded pubkey, and
        // the privkey is the most sensitive value the audit handles.
        // The ECDH shared secret is derived deterministically from the
        // privkey + ephemeral pubkey, so logging it confirms ECDH ran
        // without exposing the key.
        let sharedSecretHex = '<not computed>';
        try {
          const ss = wasm.deriveEcdhSharedSecret(scanPrivkey, ephPk);
          sharedSecretHex = bytesToHex(ss);
        } catch (e) {
          sharedSecretHex = `<threw: ${(e as Error).message ?? e}>`;
        }
        // eslint-disable-next-line no-console
        console.info(
          `[audit] deep dump for ${txId}:${onChainIndex}\n` +
            `  scanPrivkey: <redacted, ${scanPrivkey.length} bytes, all-zero? ${scanPrivkey.every(b => b === 0)}>\n` +
            `  ephemeral_pubkey (${ephPk.length} B): ${bytesToHex(ephPk)}\n` +
            `  commitment (${commitment.length} B): ${bytesToHex(commitment)}\n` +
            `  range_proof: ${rangeProof.length} bytes\n` +
            `  asset_commitment: ${slot.asset_commitment ? `${slot.asset_commitment} (${slot.asset_commitment.length / 2} B)` : '<none>'}\n` +
            `  token_data: ${slot.token_data ?? '<missing>'}\n` +
            `  mode: ${slot.mode ?? '<missing>'}\n` +
            `  routed as: ${isFullShielded ? 'FullShielded' : 'AmountShielded'}\n` +
            `  ECDH shared secret (32 B): ${sharedSecretHex}`
        );
      }

      try {
        if (isFullShielded) {
          const assetCommitment = hexToBytes(slot.asset_commitment!);
          const result = wasm.rewindFullShieldedOutput(
            scanPrivkey,
            ephPk,
            commitment,
            rangeProof,
            assetCommitment
          );
          ownedOpenings.set(`${txId}:${onChainIndex}`, {
            index: onChainIndex,
            value: BigInt(result.value),
            token: bytesToHex(result.tokenUid),
            vbf: bytesToHex(result.blindingFactor),
            abf: bytesToHex(result.assetBlindingFactor),
          });
        } else {
          // AmountShielded: token is public, encoded in token_data
          // exactly like transparent outputs. Resolve via the tx's
          // tokens[] registry.
          const tokenUidHex = resolveAmountShieldedTokenUid(slot.token_data ?? 0, tx);
          const result = wasm.rewindAmountShieldedOutput(
            scanPrivkey,
            ephPk,
            commitment,
            rangeProof,
            hexToBytes(tokenUidHex)
          );
          ownedOpenings.set(`${txId}:${onChainIndex}`, {
            index: onChainIndex,
            value: BigInt(result.value),
            token: tokenUidHex,
            vbf: bytesToHex(result.blindingFactor),
          });
        }
      } catch (err) {
        // Rewind throws when the (privkey, output) pair doesn't ECDH
        // to a valid opening. In normal operation this happens when
        // the gap-limit sweep over-attributes a tx hit to an address
        // that didn't actually receive an output (the standard wallet
        // tolerates this silently at `processing.ts:200-209`). But it
        // can also signal a derivation bug — wrong scan-key chain,
        // wrong index, wrong network — so log loudly enough that a
        // 100%-failure rate is visible in the console without burying
        // the log when failures are legitimate misses.
        rewindFailures += 1;
        // eslint-disable-next-line no-console
        console.warn(
          `[audit] rewind failed for ${txId}:${onChainIndex} ` +
            `(addr ${recipientAddress}, idx ${addressIndex}, mode ${slot.mode ?? '?'}): ` +
            `${(err as Error).message ?? err}`
        );
      }
    }
  }
  // eslint-disable-next-line no-console
  console.info(
    `[audit] shielded outputs: ${totalShieldedOutputs} total, ` +
      `${shieldedOutputsAddressedToWallet} addressed to wallet, ` +
      `${ownedOpenings.size} successfully rewound, ` +
      `${rewindFailures} failed.`
  );

  // --- 4. Index transparent outputs the wallet owns ---------------
  // Same shape as `ownedOpenings` (keyed by `<txId>:<outputIndex>`)
  // but for transparent outputs whose `decoded.address` is in our
  // derived-address map. Used by the per-row balance builder below
  // to compute transparent input activity (input references the
  // parent's output by tx_id + index, which we then look up here).
  // `isAuthority` flagged separately from value so the dropdown
  // seeder downstream still picks up token uids from mint/melt
  // outputs the wallet owns, but the balance builder can skip them —
  // an authority output's `value` carries the authority bit pattern
  // (1=mint, 2=melt), not a token amount, so summing it into the
  // public balance would inflate every owned-authority token's total
  // by 1 or 2 (e.g. owning mint+melt on DEMO would land at 10,003
  // instead of 10,000).
  const transparentOwnedOutputs = new Map<
    string,
    { value: bigint; tokenUid: string; isAuthority: boolean }
  >();
  for (const [txId, tx] of Object.entries(txs)) {
    const outs = tx.outputs ?? [];
    for (let i = 0; i < outs.length; i += 1) {
      const out = outs[i];
      const address = out.decoded?.address;
      if (!address || !addressToIndex.has(address)) continue;
      transparentOwnedOutputs.set(`${txId}:${i}`, {
        value: BigInt(out.value),
        tokenUid: resolveTransparentTokenUid(out, tx),
        isAuthority: ((out.token_data ?? 0) & 0x80) !== 0,
      });
    }
  }

  // --- 5. Build display rows + per-tx unblinding payloads ----------
  const rows: DisplayRow[] = [];
  // Per-token totals across the whole audit. Public = transparent at
  // the wallet's addresses; private = shielded openings (received -
  // spent). Computed alongside per-row balances so we don't walk
  // each tx twice.
  const totalsByToken = new Map<string, { publicBalance: bigint; privateBalance: bigint }>();
  // Symbol/name registry built from each tx's `tokens[]` array.
  //
  // Two wire shapes on the fullnode:
  //   - `address_history` emits `tokens: string[]` — bare UIDs only
  //     (the list endpoint trims metadata).
  //   - `/transaction?id=…` emits `tokens: {uid,name,symbol}[]` — full
  //     metadata objects. We no longer hit this endpoint, but we
  //     still tolerate it in case a future caller passes pre-fetched
  //     bodies.
  //
  // Stage 1: collect UIDs (filling in names/symbols inline when the
  // object shape ships them). Stage 2 below fetches the missing
  // names from `/thin_wallet/token?id=…` in parallel.
  const tokenInfoByUid = new Map<string, TokenInfo>();
  for (const tx of Object.values(txs)) {
    for (const t of tx.tokens ?? []) {
      const uid = (typeof t === 'string' ? t : t.uid)?.toLowerCase();
      if (!uid) continue;
      const meta = typeof t === 'object' ? t : null;
      // Don't overwrite richer info with a bare uid from a later
      // appearance of the same token — first-with-metadata wins.
      if (tokenInfoByUid.has(uid) && !meta) continue;
      tokenInfoByUid.set(uid, {
        tokenUid: uid,
        symbol: meta?.symbol || `${uid.slice(0, 8)}…`,
        name: meta?.name || meta?.symbol || uid,
      });
    }
  }
  // HTR always present, even with zero activity. Hardcoded so the
  // selector never shows an empty list.
  tokenInfoByUid.set(NATIVE_TOKEN_UID_HEX, {
    tokenUid: NATIVE_TOKEN_UID_HEX,
    symbol: 'HTR',
    name: 'Hathor',
  });

  // Two tx shapes carry tokens that never appear in `tx.tokens[]`:
  //   - Token-creation txs (version=2) — the new token's uid IS the
  //     tx_id and `tokens[]` is empty. The output resolves correctly
  //     via `out.token` per-row, but the dropdown index misses it.
  //   - FullShielded outputs — the uid lives inside `asset_commitment`
  //     and only emerges from `rewindFullShieldedOutput`.
  // Seed `tokenInfoByUid` from the already-resolved owned-output maps
  // so every token the wallet has activity in shows in the selector.
  // Placeholder symbol is the 8-char prefix; Stage 2 below replaces it
  // with the real name via `/thin_wallet/token?id=…`.
  const seedFromOwnedToken = (uid: string | undefined) => {
    if (!uid) return;
    const lower = uid.toLowerCase();
    if (tokenInfoByUid.has(lower)) return;
    tokenInfoByUid.set(lower, {
      tokenUid: lower,
      symbol: `${lower.slice(0, 8)}…`,
      name: lower,
    });
  };
  for (const opening of ownedOpenings.values()) seedFromOwnedToken(opening.token);
  for (const entry of transparentOwnedOutputs.values()) seedFromOwnedToken(entry.tokenUid);

  // Stage 2: fetch real name/symbol for any UID still wearing the
  // hash-prefix placeholder. One `/thin_wallet/token?id=…` round-trip
  // per unique uid — typical wallets carry <10 distinct custom
  // tokens so the parallel fetch finishes in a single RTT. Failed
  // fetches keep the placeholder; we don't want a transient network
  // hiccup to drop tokens from the dropdown.
  const unresolvedUids = Array.from(tokenInfoByUid.entries())
    .filter(([uid, info]) => uid !== NATIVE_TOKEN_UID_HEX && info.symbol.endsWith('…'))
    .map(([uid]) => uid);
  if (unresolvedUids.length > 0) {
    onProgress?.({ phase: 'history', message: 'Loading token metadata…' });
    await Promise.all(
      unresolvedUids.map(async uid => {
        const meta = await getTokenInfo(input.network, uid);
        if (!meta) return;
        tokenInfoByUid.set(uid, {
          tokenUid: uid,
          symbol: meta.symbol,
          name: meta.name,
        });
      })
    );
  }

  for (const [txId, tx] of Object.entries(txs)) {
    const outputsForTx: OpeningEntry[] = [];
    const inputsForTx: OpeningEntry[] = [];

    // Shielded outputs: every owned-opening recorded for this tx.
    const transparentCount = tx.outputs?.length ?? 0;
    const shieldedOutputs = tx.shielded_outputs ?? [];
    for (let s = 0; s < shieldedOutputs.length; s += 1) {
      const onChainIndex = transparentCount + s;
      const opening = ownedOpenings.get(`${txId}:${onChainIndex}`);
      if (opening) outputsForTx.push(opening);
    }

    // Shielded inputs: a shielded input references a parent tx +
    // output index. If the wallet owned that parent output (we'd
    // have rewound it during step 3), the same opening unblinds the
    // input. Inputs the wallet doesn't own the parent of stay
    // opaque — privacy-correct, the auditor has no view there.
    const inputs = tx.inputs ?? [];
    for (let i = 0; i < inputs.length; i += 1) {
      const input = inputs[i];
      if (input.type !== 'shielded') continue;
      if (!input.tx_id || input.index === undefined) continue;
      const parentOpening = ownedOpenings.get(`${input.tx_id}:${input.index}`);
      if (!parentOpening) continue;
      inputsForTx.push({
        index: i, // Position in this tx's inputs[] — the explorer's verifier keys input openings by this.
        value: parentOpening.value,
        token: parentOpening.token,
        vbf: parentOpening.vbf,
        ...(parentOpening.abf ? { abf: parentOpening.abf } : {}),
      });
    }

    // Per-token, per-tx balance (cleartext-only). Shielded openings
    // and transparent owned outputs/inputs both count, with the
    // public-vs-private split tracked separately for the global
    // totals at the end.
    const balanceByToken = new Map<string, { delta: bigint; pub: bigint; priv: bigint }>();
    const bumpToken = (token: string, channel: 'pub' | 'priv', delta: bigint) => {
      const cur = balanceByToken.get(token) ?? { delta: 0n, pub: 0n, priv: 0n };
      cur.delta += delta;
      cur[channel] += delta;
      balanceByToken.set(token, cur);
    };

    for (const o of outputsForTx) bumpToken(o.token, 'priv', o.value);
    for (const i of inputsForTx) bumpToken(i.token, 'priv', -i.value);

    // Transparent owned outputs in this tx → received.
    // Authority outputs flag activity (so the row still surfaces in
    // the wallet's history) but don't bump balances — their `value`
    // is the authority bit pattern, not a token amount.
    let hasTransparentActivity = false;
    for (let i = 0; i < (tx.outputs ?? []).length; i += 1) {
      const owned = transparentOwnedOutputs.get(`${txId}:${i}`);
      if (!owned) continue;
      hasTransparentActivity = true;
      if (owned.isAuthority) continue;
      bumpToken(owned.tokenUid, 'pub', owned.value);
    }
    // Transparent inputs whose parent we own → spent.
    for (const input of inputs) {
      if (input.type === 'shielded') continue;
      if (!input.tx_id || input.index === undefined) continue;
      const owned = transparentOwnedOutputs.get(`${input.tx_id}:${input.index}`);
      if (!owned) continue;
      hasTransparentActivity = true;
      if (owned.isAuthority) continue;
      bumpToken(owned.tokenUid, 'pub', -owned.value);
    }

    // Add per-tx deltas into the global per-token totals.
    for (const [tokenUid, { pub, priv }] of balanceByToken.entries()) {
      const cur = totalsByToken.get(tokenUid) ?? { publicBalance: 0n, privateBalance: 0n };
      cur.publicBalance += pub;
      cur.privateBalance += priv;
      totalsByToken.set(tokenUid, cur);
    }

    const balance = Array.from(balanceByToken.entries()).map(([tokenUid, { delta }]) => ({
      tokenUid,
      tokenSymbol: resolveTokenSymbolFromTx(tokenUid, tx),
      delta,
    }));

    const payload = encodeUnblindingPayload(txId, outputsForTx, inputsForTx);

    rows.push({
      txId,
      timestamp: tx.timestamp ?? 0,
      balance,
      hasShieldedActivity: outputsForTx.length > 0 || inputsForTx.length > 0,
      hasTransparentActivity,
      explorerLink: buildExplorerLink(input.network, txId, payload),
    });
  }

  // Newest first — matches user expectation when scanning the list.
  rows.sort((a, b) => b.timestamp - a.timestamp);

  // Final tokens list: HTR first (it's always there even with zero
  // activity), then everything else sorted by symbol for stable
  // dropdown ordering.
  const htr = tokenInfoByUid.get(NATIVE_TOKEN_UID_HEX)!;
  const otherTokens = Array.from(tokenInfoByUid.values())
    .filter(t => t.tokenUid !== NATIVE_TOKEN_UID_HEX)
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  const tokens: TokenInfo[] = [htr, ...otherTokens];

  // Project the totals map into the result shape, with a zero-zero
  // entry for HTR if no tx ever moved any HTR (so the UI can always
  // surface a balance pair for the default selection).
  const balances: Record<string, TokenBalance> = {};
  for (const t of tokens) {
    const total = totalsByToken.get(t.tokenUid);
    balances[t.tokenUid] = {
      tokenUid: t.tokenUid,
      publicBalance: total?.publicBalance ?? 0n,
      privateBalance: total?.privateBalance ?? 0n,
    };
  }

  onProgress?.({ phase: 'done', total: rows.length });
  return { rows, tokens, balances };
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Convert a `RawTx` from the `address_history` endpoint into the
 * shape the rest of the audit pipeline expects:
 *
 *   - Shielded entries (those with `type === 'shielded'`) lifted out
 *     of `outputs[]` into a separate `shielded_outputs[]` field,
 *     keeping their original order.
 *   - Transparent entries kept in `outputs[]`. `value` coerced to
 *     bigint at this boundary so downstream sums don't have to.
 *
 * Mirrors wallet-lib's `txUtils.normalizeShieldedOutputs` case (a).
 * The on-the-wire mixed-array shape is what hathor-core's
 * `address_history` emits today; the audit consumes the post-split
 * shape because the rewind + balance code is keyed by separate
 * arrays — same shape as the standalone `/transaction?id=…` endpoint.
 */
function splitShieldedFromHistoryTx(raw: RawTx): FullNodeTx {
  const transparentOutputs: FullNodeTransparentOutput[] = [];
  const shieldedOutputs: FullNodeShieldedOutput[] = [];
  for (const out of raw.outputs ?? []) {
    if (isShieldedOutput(out)) {
      shieldedOutputs.push({
        mode: out.mode ?? (out.asset_commitment ? 2 : 1),
        commitment: out.commitment,
        range_proof: out.range_proof,
        ephemeral_pubkey: out.ephemeral_pubkey,
        asset_commitment: out.asset_commitment,
        token_data: out.token_data,
        decoded: out.decoded,
      });
    } else {
      transparentOutputs.push({
        value: BigInt(out.value),
        token_data: out.token_data,
        token: out.token ?? null,
        decoded: out.decoded,
      });
    }
  }
  return {
    timestamp: raw.timestamp,
    outputs: transparentOutputs,
    shielded_outputs: shieldedOutputs,
    inputs: (raw.inputs ?? []) as FullNodeInput[],
    tokens: raw.tokens,
  };
}

function isShieldedOutput(out: RawOutput): out is RawShieldedOutput {
  // The discriminator field `type` only exists on shielded entries —
  // wallet-lib's `IHistoryOutput` for transparent outputs intentionally
  // omits it (matches the standalone `/transaction?id=…` schema), so
  // the cast here is just to satisfy the type-narrowing path.
  return (out as { type?: string }).type === 'shielded';
}

/**
 * For an AmountShielded output, the token UID is encoded in
 * `token_data` exactly like transparent outputs: byte 0 is the
 * authority flag (ignored here), byte 1+ is the index into
 * `tx.tokens[]`. Index 0 == native HTR (the `00…` 32-byte UID).
 */
/**
 * Resolve the token UID of a transparent output. Some fullnode
 * endpoints emit the resolved `token` UID directly; older or
 * non-thinwallet endpoints only ship `token_data`, in which case we
 * resolve via `tx.tokens[]` (same convention as
 * `resolveAmountShieldedTokenUid`). Index 0 == native HTR.
 */
function resolveTransparentTokenUid(out: FullNodeTransparentOutput, tx: FullNodeTx): string {
  if (typeof out.token === 'string' && out.token.length > 0) {
    return out.token === '00' ? NATIVE_TOKEN_UID_HEX : out.token.toLowerCase();
  }
  return resolveAmountShieldedTokenUid(out.token_data ?? 0, tx);
}

function resolveAmountShieldedTokenUid(tokenData: number, tx: FullNodeTx): string {
  const authorityMask = 0x80;
  const tokenIndex = tokenData & ~authorityMask;
  if (tokenIndex === 0) return NATIVE_TOKEN_UID_HEX;
  const customTokens = tx.tokens ?? [];
  const tok = customTokens[tokenIndex - 1];
  // Fullnode emits the token uid as a 64-char hex string for custom
  // tokens. Native token (`00`) is special-cased above.
  return typeof tok === 'string' ? tok : tok?.uid ?? NATIVE_TOKEN_UID_HEX;
}

function resolveTokenSymbolFromTx(tokenUidHex: string, tx: FullNodeTx): string {
  if (tokenUidHex === NATIVE_TOKEN_UID_HEX || tokenUidHex === '00') return 'HTR';
  const customTokens = tx.tokens ?? [];
  const match = customTokens.find(
    t => (typeof t === 'string' ? t : t?.uid)?.toLowerCase() === tokenUidHex.toLowerCase()
  );
  if (match && typeof match !== 'string' && match?.symbol) return match.symbol;
  // Custom token uid we can't resolve symbol-wise — fall back to a
  // short prefix so the row stays readable.
  return `${tokenUidHex.slice(0, 8)}…`;
}

// ─── Wire types ──────────────────────────────────────────────────────
//
// Local TS types for the bits of the fullnode tx we touch. The full
// schema (Zod-validated by `transactionApiSchema`) is much richer;
// this typings module is just the projection the audit pipeline
// actually reads.

interface FullNodeShieldedOutput {
  mode?: number;
  commitment: string;
  range_proof: string;
  ephemeral_pubkey: string;
  asset_commitment?: string;
  token_data?: number;
  decoded?: { address?: string };
}

interface FullNodeTransparentOutput {
  value: bigint;
  token_data: number;
  /** Some fullnode endpoints include the resolved uid directly. */
  token?: string | null;
  decoded?: { address?: string };
}

interface FullNodeShieldedInput {
  type: 'shielded';
  tx_id?: string;
  index?: number;
}

interface FullNodeTransparentInput {
  type?: 'transparent';
  tx_id?: string;
  index?: number;
}

type FullNodeInput = FullNodeShieldedInput | FullNodeTransparentInput;

interface FullNodeToken {
  uid: string;
  name?: string;
  symbol?: string;
}

interface FullNodeTx {
  timestamp?: number;
  outputs?: FullNodeTransparentOutput[];
  shielded_outputs?: FullNodeShieldedOutput[];
  inputs?: FullNodeInput[];
  tokens?: (string | FullNodeToken)[];
}
