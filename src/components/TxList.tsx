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
 *
 * Pagination is local-only: the orchestrator already has every row
 * in memory after `runAudit` resolves, so the only cost of "loading
 * more" is rendering more DOM nodes. PAGE_SIZE picks the cut-off
 * conservatively — large enough to skim a day's activity at a glance,
 * small enough that a >500-tx wallet doesn't slow scrolling.
 */

import { useEffect, useMemo, useState } from 'react';
import type { DisplayRow } from '../services/audit';
import type { Network } from '../services/networks';

const PAGE_SIZE = 20;

interface Props {
  rows: DisplayRow[];
  network: Network;
  /** Reset back to the empty form so the user can paste different keys. */
  onReset: () => void;
  /** Re-run the audit with the same keys, picking up new txs since the last run. */
  onReload: () => void;
}

export function TxList({ rows, network, onReset, onReload }: Props) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));

  // Reset to page 1 whenever the underlying rows change (Reload or
  // re-audit). Without this a user on page 5 after a Reload could end
  // up showing the same offset against a newly-shorter list — or a
  // blank table if the new list has fewer than 5 pages.
  useEffect(() => {
    setPage(1);
  }, [rows]);

  const visibleRows = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return rows.slice(start, start + PAGE_SIZE);
  }, [rows, page]);

  return (
    <div className="tx-list">
      <div className="tx-list-header">
        <p>
          {rows.length} transaction{rows.length === 1 ? '' : 's'} found at this wallet's
          shielded receive addresses on <strong>{network.label}</strong>.
        </p>
        <div className="tx-list-actions">
          <button type="button" onClick={onReload} className="secondary-button">
            Reload
          </button>
          <button type="button" onClick={onReset} className="secondary-button">
            New audit
          </button>
        </div>
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
        <>
          <table className="tx-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Transaction</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(row => (
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

          {totalPages > 1 && (
            <Pagination page={page} totalPages={totalPages} onChange={setPage} />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Numeric pagination controls with prev/next + a windowed view of
 * page numbers. Shows up to 7 page buttons centered on the current
 * page; first/last + ellipses ensure the user can always jump to
 * either end without scrubbing through every page. For typical
 * audits (≤ ~50 pages) the ellipsis paths rarely trigger.
 */
function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}) {
  const pages = computePageWindow(page, totalPages);
  return (
    <nav className="pagination" aria-label="Pagination">
      <button
        type="button"
        className="pagination-button"
        onClick={() => onChange(page - 1)}
        disabled={page === 1}
        aria-label="Previous page"
      >
        ‹ Prev
      </button>
      {pages.map((p, i) =>
        p === '…' ? (
          <span key={`gap-${i}`} className="pagination-gap" aria-hidden="true">
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            className={`pagination-button ${p === page ? 'pagination-button-active' : ''}`}
            onClick={() => onChange(p)}
            aria-current={p === page ? 'page' : undefined}
          >
            {p}
          </button>
        )
      )}
      <button
        type="button"
        className="pagination-button"
        onClick={() => onChange(page + 1)}
        disabled={page === totalPages}
        aria-label="Next page"
      >
        Next ›
      </button>
    </nav>
  );
}

/**
 * Pick which page numbers to render. Always shows 1 and `total`;
 * fills in up to 5 numbers centered on `current` between them, with
 * ellipses on either side when there's a gap. Output is interleaved
 * `number | '…'` so the renderer can place ellipses inline.
 */
function computePageWindow(current: number, total: number): (number | '…')[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const result: (number | '…')[] = [1];
  const windowStart = Math.max(2, current - 2);
  const windowEnd = Math.min(total - 1, current + 2);
  if (windowStart > 2) result.push('…');
  for (let p = windowStart; p <= windowEnd; p += 1) result.push(p);
  if (windowEnd < total - 1) result.push('…');
  result.push(total);
  return result;
}

function shortHash(hash: string): string {
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

function formatTimestamp(unixSeconds: number): string {
  if (!unixSeconds) return '—';
  return new Date(unixSeconds * 1000).toLocaleString();
}
