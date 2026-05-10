/**
 * Audit results table.
 *
 * One row per tx, sorted newest first. Columns are deliberately
 * minimal — date, short tx id, and an explorer link that includes
 * the precomputed `#unblind=…` fragment when the audit recovered any
 * openings for the tx. Per-token balance + transparent/shielded
 * badges were dropped because they got noisy on multi-token txs;
 * the explorer's unblinding view is the canonical place to inspect
 * cleartext per-output values anyway.
 */

import type { DisplayRow } from '../services/audit';
import type { Network } from '../services/networks';

interface Props {
  rows: DisplayRow[];
  network: Network;
  onReset: () => void;
}

export function TxList({ rows, network, onReset }: Props) {
  return (
    <div className="tx-list">
      <div className="tx-list-header">
        <p>
          {rows.length} transaction{rows.length === 1 ? '' : 's'} found at this wallet's
          shielded receive addresses on <strong>{network.label}</strong>.
        </p>
        <button type="button" onClick={onReset} className="secondary-button">
          New audit
        </button>
      </div>

      {rows.length === 0 && (
        <div className="empty-state">
          <p>No transactions found at the derived addresses.</p>
          <p className="empty-state-hint">
            Either the wallet hasn't received any txs yet, or the keys belong to a
            different network. Double-check the network selector and try again.
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <table className="tx-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Transaction</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.txId}>
                <td className="col-date">{formatTimestamp(row.timestamp)}</td>
                <td className="col-tx">
                  <code title={row.txId}>{shortHash(row.txId)}</code>
                </td>
                <td className="col-action">
                  <a
                    className="explorer-link"
                    href={row.explorerLink}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {row.hasShieldedActivity ? 'View unblinded' : 'View'} ↗
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function shortHash(hash: string): string {
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

function formatTimestamp(unixSeconds: number): string {
  if (!unixSeconds) return '—';
  return new Date(unixSeconds * 1000).toLocaleString();
}
