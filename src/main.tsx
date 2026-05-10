// MUST be first. Sets `globalThis.Buffer / process / global` before any
// module that relies on them (bitcore-lib, wallet-lib's Zod schemas,
// transitively axios) gets evaluated. See polyfills.ts for why.
import './polyfills';

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/app.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
