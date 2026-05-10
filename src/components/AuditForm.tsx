/**
 * Form: network selector + spend xpub + scan xpriv + Audit button.
 *
 * Validates keys synchronously on submit (cheap — `bitcore-lib`'s
 * `HDPublicKey` / `HDPrivateKey` constructors throw on malformed
 * strings). Network presets come from `services/networks`; the
 * "custom" preset expands two extra fields.
 */

import { useState } from 'react';
import {
  customNetwork,
  NETWORKS,
  type Network,
} from '../services/networks';
import type { AuditInput } from '../services/audit';

interface Props {
  onSubmit: (input: AuditInput) => void;
}

export function AuditForm({ onSubmit }: Props) {
  const [networkId, setNetworkId] = useState<string>('shielded-testnet');
  const [customFullnodeUrl, setCustomFullnodeUrl] = useState('');
  const [customExplorerUrl, setCustomExplorerUrl] = useState('');
  const [spendXpub, setSpendXpub] = useState('');
  const [scanXpriv, setScanXpriv] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    let network: Network | undefined;
    if (networkId === 'custom') {
      if (!customFullnodeUrl.trim() || !customExplorerUrl.trim()) {
        setError('Custom network requires both fullnode and explorer URLs.');
        return;
      }
      network = customNetwork(customFullnodeUrl.trim(), customExplorerUrl.trim());
    } else {
      network = NETWORKS.find(n => n.id === networkId);
    }
    if (!network) {
      setError('Unknown network preset.');
      return;
    }

    if (!spendXpub.trim() || !scanXpriv.trim()) {
      setError('Both spend xpub and scan xpriv are required.');
      return;
    }

    onSubmit({ network, spendXpub: spendXpub.trim(), scanXpriv: scanXpriv.trim() });
  };

  return (
    <form className="audit-form" onSubmit={submit}>
      <label className="field">
        <span className="field-label">Network</span>
        <select
          value={networkId}
          onChange={e => setNetworkId(e.target.value)}
          className="field-input"
        >
          {NETWORKS.map(n => (
            <option key={n.id} value={n.id}>
              {n.label}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
      </label>

      {networkId === 'custom' && (
        <>
          <label className="field">
            <span className="field-label">Fullnode v1a URL</span>
            <input
              className="field-input"
              type="url"
              placeholder="https://my-node.example.com/v1a/"
              value={customFullnodeUrl}
              onChange={e => setCustomFullnodeUrl(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Explorer URL</span>
            <input
              className="field-input"
              type="url"
              placeholder="https://my-explorer.example.com/"
              value={customExplorerUrl}
              onChange={e => setCustomExplorerUrl(e.target.value)}
            />
          </label>
        </>
      )}

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
