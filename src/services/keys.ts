/**
 * Key validation + per-index derivation utilities.
 *
 * Re-uses wallet-lib's `deriveShieldedAddress` for the receive-side
 * P2PKH address (the field every shielded output records as
 * `decoded.address` on-chain). Re-implements the scan-privkey
 * derivation locally because wallet-lib's version is tightly coupled
 * to `IStorage` + a PIN-encrypted xpriv — for the audit case we
 * already have the cleartext xpriv in memory.
 *
 * The local re-implementation is ~5 lines and matches wallet-lib's
 * `deriveScanPrivkeyForAddress` exactly (same path, same
 * `deriveNonCompliantChild` quirk for bitcore-lib's historical
 * private-key serialization bug — see comment at
 * `hathor-wallet-lib/src/shielded/processing.ts:69`).
 */

import bitcore from 'bitcore-lib';
// Deep import — wallet-lib's `lib/index.js` namespace doesn't re-
// export `shieldedAddress`, so we reach into the published lib/
// path directly. The package pin in package.json is exact
// (0.0.8-shielded), so the path stability risk is bounded; if a
// future bump moves the file, the build breaks loudly at the
// import level rather than silently at runtime.
import { deriveShieldedAddress } from '@hathor/wallet-lib/lib/utils/shieldedAddress';

// bitcore-lib's published types are deficient (see types/bitcore-lib.d.ts);
// destructure these as `any` so call sites stay readable without
// littering each one with a separate cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { HDPrivateKey, HDPublicKey } = bitcore as any;

/**
 * Validate the two audit keys. Throws with a precise message on the
 * first one that doesn't parse — the form catches this and surfaces
 * the message under the offending input. The `bitcore-lib`
 * constructors throw plain `Error`s, so we wrap with our own message
 * and pass through the original under `cause` for debugging.
 */
export function validateAuditKeys(spendXpub: string, scanXpriv: string): void {
  try {
    new HDPublicKey(spendXpub.trim());
  } catch (e) {
    throw new Error(`Spend xpub is not a valid BIP32 xpub: ${(e as Error).message}`, {
      cause: e,
    });
  }
  try {
    new HDPrivateKey(scanXpriv.trim());
  } catch (e) {
    throw new Error(`Scan xpriv is not a valid BIP32 xpriv: ${(e as Error).message}`, {
      cause: e,
    });
  }
}

/**
 * Derive the spend-side P2PKH address at a given BIP32 index.
 *
 * `deriveShieldedAddress` takes BOTH the scan xpub and the spend
 * xpub because the standard wallet flow needs both to encode a full
 * shielded address (base58 of `[version || scanPubkey || spendPubkey || checksum]`).
 * For the audit case we only need the `.spendAddress` field — the
 * P2PKH the recipient receives — so we derive the scan xpub from
 * the audit's scan xpriv to satisfy the function signature.
 */
export function deriveSpendAddress(
  spendXpub: string,
  scanXpriv: string,
  index: number,
  networkName: string
): string {
  const scanXpubFromXpriv = new HDPrivateKey(scanXpriv.trim()).hdPublicKey.xpubkey;
  const info = deriveShieldedAddress(scanXpubFromXpriv, spendXpub.trim(), index, networkName);
  return info.spendAddress;
}

/**
 * Derive the scan privkey at a given BIP32 index.
 *
 * Mirrors `hathor-wallet-lib/src/shielded/processing.ts:54-80`. The
 * `deriveNonCompliantChild` (NOT `derive`) is mandatory: bitcore-lib's
 * private-key serialization for the standard BIP32 derive path has a
 * historical bug, and the wallet-side derivation has always used the
 * non-compliant path; using the standard one here would derive a
 * different key and rewind would silently fail.
 *
 * Returns the raw 32-byte private key as a `Uint8Array` (matching
 * wasm-bindgen's expected shape for `rewindAmount/FullShieldedOutput`).
 */
export function deriveScanPrivkey(scanXpriv: string, index: number): Uint8Array {
  const hd = new HDPrivateKey(scanXpriv.trim());
  const child = hd.deriveNonCompliantChild(index);
  // bitcore-lib's `.privateKey.toBuffer({size: 32})` zero-pads keys
  // with leading zero bytes. Required because secp256k1 rejects keys
  // that aren't exactly 32 bytes. Copy into a fresh Uint8Array (rather
  // than a `new Uint8Array(buf.buffer, …)` view) to avoid any chance
  // the underlying `Buffer` shares an ArrayBuffer pool with adjacent
  // allocations under vite's polyfill.
  const buf = child.privateKey.toBuffer({ size: 32 });
  const out = new Uint8Array(32);
  out.set(buf);
  return out;
}

/**
 * Diagnostic: verify that the asymmetric derivation paths actually
 * produce a matching keypair for this user's keys at a given index.
 *
 * Returns `true` when:
 *
 *   ECDH-pubkey-from-private-via-NonCompliant === pubkey-from-public-via-Standard
 *
 * Wallet-lib relies on this equivalence in `processing.ts:69-70` and
 * `shieldedAddress.ts:81-83` — the comment there claims the pair lines
 * up because bitcore-lib's `HDPublicKey.deriveChild` has the same
 * (buggy) serialization shape as `HDPrivateKey.deriveNonCompliantChild`.
 * If that ever drifts (e.g. a bitcore-lib version that fixes the
 * public-side bug while keeping `deriveNonCompliantChild`), every
 * audit would silently rewind-fail with no obvious cause. This check
 * surfaces the mismatch immediately.
 */
export function checkAsymmetricDerivationPairs(
  scanXpriv: string,
  index: number
): { matches: boolean; privkeyPub: string; addressPub: string } {
  const hdPriv = new HDPrivateKey(scanXpriv.trim());
  const childPriv = hdPriv.deriveNonCompliantChild(index);
  const privkeyPub: string = childPriv.publicKey.toString();

  const hdPub = new HDPublicKey(hdPriv.hdPublicKey.xpubkey);
  const childPub = hdPub.deriveChild(index);
  const addressPub: string = childPub.publicKey.toString();

  return { matches: privkeyPub === addressPub, privkeyPub, addressPub };
}
