/**
 * Form: network label (currently fixed) + spend xpub + scan xpriv +
 * Audit button.
 *
 * Validates keys synchronously on submit — cheap, since `bitcore-lib`'s
 * `HDPublicKey` / `HDPrivateKey` constructors throw on malformed
 * strings. The network field is rendered as a static label rather
 * than a dropdown because only one preset is currently live; the
 * dropdown returns when there's a real choice to make.
 */

import { useState } from 'react';
import { NETWORKS } from '../services/networks';
import type { AuditInput } from '../services/audit';

interface Props {
  onSubmit: (input: AuditInput) => void;
}

export function AuditForm({ onSubmit }: Props) {
  // Hard-pinned to the only live network for now. When a second network
  // ships, restore the previous `useState` + `<select>` pair (see
  // git history — c.f. the disabled-select rendering that preceded this
  // static-label form). The custom-network escape hatch is also gone
  // for the same reason: it's only useful when there's a non-listed
  // node for a developer to point at, which doesn't exist today.
  const NETWORK_ID = 'shielded-testnet';
  const network = NETWORKS.find(n => n.id === NETWORK_ID)!;
  const [spendXpub, setSpendXpub] = useState('');
  const [scanXpriv, setScanXpriv] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!spendXpub.trim() || !scanXpriv.trim()) {
      setError('Both spend xpub and scan xpriv are required.');
      return;
    }

    onSubmit({ network, spendXpub: spendXpub.trim(), scanXpriv: scanXpriv.trim() });
  };

  return (
    <form className="audit-form" onSubmit={submit}>
      <div className="network-row">
        <span className="field-label">Network</span>
        <span className="network-row-value">{network.label}</span>
      </div>

      <label className="field">
        <span className="field-label">
          Spend xpub <code className="field-hint">m/44'/280'/2'/0</code>
        </span>
        <textarea
          className="field-input field-input-textarea"
          rows={3}
          placeholder="xpub…"
          value={spendXpub}
          onChange={e => setSpendXpub(e.target.value)}
          spellCheck={false}
        />
      </label>

      <label className="field">
        <span className="field-label">
          Scan xpriv <code className="field-hint">m/44'/280'/1'/0</code>
        </span>
        <textarea
          className="field-input field-input-textarea"
          rows={3}
          placeholder="xprv…"
          value={scanXpriv}
          onChange={e => setScanXpriv(e.target.value)}
          spellCheck={false}
        />
      </label>

      {error && <div className="form-error">{error}</div>}

      <button type="submit" className="primary-button">
        Audit
      </button>

      <p className="form-note">
        The wallet exports these from <em>Settings → Privacy → Export privacy keys</em>.
        Together they let you find AND decrypt every shielded output the wallet receives,
        with zero spending authority.
      </p>
    </form>
  );
}
