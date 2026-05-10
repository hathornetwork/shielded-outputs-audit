/**
 * Explicit Node-stdlib globals shim. Imported as the first statement
 * in `main.tsx` so it runs before any module that touches `Buffer`,
 * `process`, or the `global` alias — `bitcore-lib` reaches for all
 * three eagerly during module init, and `wallet-lib` does the same
 * via its `bigIntCoercibleSchema` and Zod registrations.
 *
 * Why this file exists alongside `vite-plugin-node-polyfills`:
 *
 *   The plugin sets up a `<banner>` injection through Vite's `esbuild`
 *   option to define the globals. Vite 8 switched its bundler from
 *   esbuild to oxc, and the plugin's banner is silently ignored on the
 *   new path — surfacing as `ReferenceError: Buffer is not defined` in
 *   the production bundle (dev still works because Vite serves modules
 *   un-bundled there). Until the plugin updates for oxc, we set the
 *   globals ourselves.
 *
 *   The plugin still does the useful half of the work: aliasing
 *   `import 'buffer'` / `import 'process'` to its browser-friendly
 *   shims via Vite's `resolve.alias`. So we can re-export those exact
 *   shims here without bringing in a separate `buffer` package.
 */

import { Buffer } from 'buffer';
import process from 'process';

const g = globalThis as unknown as Record<string, unknown>;
if (!g.Buffer) g.Buffer = Buffer;
if (!g.process) g.process = process;
if (!g.global) g.global = globalThis;
