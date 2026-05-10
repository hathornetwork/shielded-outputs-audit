import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

/**
 * Vite config notes:
 *
 * - `nodePolyfills` shims Node stdlib for `@hathor/wallet-lib` and its
 *   transitive deps (`bitcore-lib` pulls in `crypto`, `Buffer`, `stream`).
 *   We enable both `Buffer` and `process` globals because wallet-lib's
 *   ZodSchema validators read `process.env` lazily.
 *
 * - `optimizeDeps.exclude` for `@hathor/ct-crypto-wasm` keeps Vite's dev
 *   pre-bundler out of the wasm-pack output. The package ships with a
 *   `module` entry pointing at `hathor_ct_crypto_wasm.js`, which loads
 *   the `.wasm` via a relative URL — Vite's pre-bundler would re-bundle
 *   the JS and break the relative-URL contract.
 */
export default defineConfig({
  // `./` makes every emitted asset URL relative to `index.html`, so the
  // same `dist/` artifact works whether it's served from the site root
  // (S3 + CloudFront target), `https://hathornetwork.github.io/shielded-outputs-audit/`
  // (the GitHub Pages preview), or any other subpath. Avoids having to
  // rebuild for each deploy target.
  base: './',
  plugins: [
    react(),
    nodePolyfills({
      // Polyfill Buffer + process globally so `bitcore-lib` and
      // `axios` don't trip on missing browser shims at runtime.
      globals: { Buffer: true, process: true },
      protocolImports: true,
    }),
  ],
  optimizeDeps: {
    exclude: ['@hathor/ct-crypto-wasm'],
  },
  server: {
    port: 3020,
  },
});
