/**
 * Two-screen state machine: the form, then the results.
 *
 * Keeping it as a single component because the audit flow is a
 * one-shot pipeline (paste keys → see results → optionally re-paste
 * for another audit). No router, no tabs, no shared layout chrome
 * worth extracting.
 */

import { useState } from 'react';
import { AuditForm } from './components/AuditForm';
import { TokenSelector } from './components/TokenSelector';
import { TxList } from './components/TxList';
import { runAudit, type AuditInput, type AuditProgress, type AuditResult } from './services/audit';

type AuditState =
  | { kind: 'form' }
  | { kind: 'running'; progress: AuditProgress }
  | { kind: 'done'; result: AuditResult; input: AuditInput }
  | { kind: 'error'; error: Error; input: AuditInput };

export default function App() {
  const [state, setState] = useState<AuditState>({ kind: 'form' });

  // Initial running-view state. WASM init + address derivation run
  // before the orchestrator's first onProgress fires (combined ~100ms
  // on a warm cache), so seeding the message with the *next* visible
  // phase keeps the UI from flashing an "Initializing…" placeholder
  // that the user can't usefully act on. The orchestrator overrides
  // it as soon as the address-history sweep starts.
  const initialProgress: AuditProgress = {
    phase: 'history',
    message: 'Loading address history…',
  };

  const onSubmit = async (input: AuditInput) => {
    setState({ kind: 'running', progress: initialProgress });
    try {
      const result = await runAudit(input, progress =>
        setState({ kind: 'running', progress })
      );
      setState({ kind: 'done', result, input });
    } catch (e) {
      setState({ kind: 'error', error: e as Error, input });
    }
  };

  const reset = () => setState({ kind: 'form' });

  const reload = async () => {
    if (state.kind !== 'done') return;
    const input = state.input;
    setState({ kind: 'running', progress: initialProgress });
    try {
      const result = await runAudit(input, progress =>
        setState({ kind: 'running', progress })
      );
      setState({ kind: 'done', result, input });
    } catch (e) {
      setState({ kind: 'error', error: e as Error, input });
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Hathor shielded outputs auditor</h1>
        <p className="app-tagline">
          Paste a wallet's exported privacy keys to view its shielded transaction history.
          Keys are processed locally — nothing is sent to a server.
        </p>
      </header>
      <main className="app-main">
        {state.kind === 'form' && <AuditForm onSubmit={onSubmit} />}
        {state.kind === 'running' && <RunningView progress={state.progress} />}
        {state.kind === 'done' && (
          <>
            <TokenSelector
              tokens={state.result.tokens}
              balances={state.result.balances}
            />
            <TxList
              rows={state.result.rows}
              network={state.input.network}
              onReset={reset}
              onReload={reload}
            />
          </>
        )}
        {state.kind === 'error' && (
          <ErrorView error={state.error} onReset={reset} />
        )}
      </main>
    </div>
  );
}

function RunningView({ progress }: { progress: AuditProgress }) {
  // The orchestrator's progress.message takes precedence when
  // present; otherwise we fall back to a phase-specific default. No
  // separate counter suffix here — the orchestrator embeds counts
  // into the message itself when relevant.
  const message =
    progress.message ||
    {
      history: 'Loading address history…',
      rewind: 'Rewinding shielded outputs…',
      done: 'Done',
    }[progress.phase];
  return (
    <div className="running">
      <div className="spinner" aria-hidden="true" />
      <p>{message}</p>
    </div>
  );
}

function ErrorView({ error, onReset }: { error: Error; onReset: () => void }) {
  return (
    <div className="error">
      <h2>Audit failed</h2>
      <pre>{error.message}</pre>
      <button type="button" onClick={onReset}>
        Try again
      </button>
    </div>
  );
}
