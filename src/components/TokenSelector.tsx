/**
 * Token dropdown + public/private balance pair.
 *
 * Sits above `<TxList>` so the user sees the high-level balance
 * snapshot first and the per-tx breakdown second. HTR is the
 * default selection because the audit page never renders an empty
 * state when a wallet exists — even a brand-new wallet has the
 * (0 / 0) HTR pair to show, which is itself an audit-relevant
 * fact ("this wallet has never received anything yet").
 */

import { useState } from 'react';
// Deep import — wallet-lib's main `lib/index.js` namespace doesn't
// re-export `prettyValue`. Same stability tradeoff as the
// `shieldedAddress` / schema imports elsewhere in this app; the
// exact-pin in package.json bounds the path-stability risk.
import { prettyValue } from '@hathor/wallet-lib/lib/utils/numbers';
import type { TokenBalance, TokenInfo } from '../services/audit';

interface Props {
  tokens: TokenInfo[];
  balances: Record<string, TokenBalance>;
}

const NATIVE_TOKEN_UID_HEX = '0'.repeat(64);

export function TokenSelector({ tokens, balances }: Props) {
  // HTR-first by default. The audit's `tokens` array always lists
  // HTR at index 0 (see `runAudit`), but we look it up by uid so the
  // default stays correct if the ordering ever changes.
  const [selectedUid, setSelectedUid] = useState<string>(NATIVE_TOKEN_UID_HEX);

  const selectedToken =
    tokens.find(t => t.tokenUid === selectedUid) ?? tokens[0];
  const balance = balances[selectedToken.tokenUid] ?? {
    tokenUid: selectedToken.tokenUid,
    publicBalance: 0n,
    privateBalance: 0n,
  };

  return (
    <div className="token-selector">
      <div className="token-selector-row">
        <select
          className="token-selector-input"
          value={selectedToken.tokenUid}
          onChange={e => setSelectedUid(e.target.value)}
          aria-label="Token"
        >
          {tokens.map(t => (
            <option key={t.tokenUid} value={t.tokenUid}>
              {t.symbol} {t.symbol !== t.name ? `· ${t.name}` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="balance-grid">
        <div className="balance-card">
          <div className="balance-card-label">Public balance</div>
          <div className="balance-card-value">
            {prettyValue(balance.publicBalance)}{' '}
            <span className="balance-card-symbol">{selectedToken.symbol}</span>
          </div>
          <div className="balance-card-hint">
            Sum of transparent activity at the wallet's shielded receive addresses
            — anyone watching the chain can compute this.
          </div>
        </div>
        <div className="balance-card balance-card-private">
          <div className="balance-card-label">Private balance</div>
          <div className="balance-card-value">
            {prettyValue(balance.privateBalance)}{' '}
            <span className="balance-card-symbol">{selectedToken.symbol}</span>
          </div>
          <div className="balance-card-hint">
            Sum of shielded openings recovered with the scan key — visible only to
            holders of these audit credentials.
          </div>
        </div>
      </div>
    </div>
  );
}
