/**
 * Network presets the audit page exposes in the dropdown.
 *
 * Each preset bundles the fullnode v1a base URL (used for
 * `/thin_wallet/address_history` and `/transaction?id=…` lookups) and
 * the explorer URL (used for the per-row "View unblinded" link). The
 * `network` string is the name `bitcore-lib` recognizes for address
 * encoding via wallet-lib's `deriveShieldedAddress`.
 *
 * The "custom" preset is the audit page's escape hatch for unlisted
 * networks (e.g. a developer's local Hathor node). The form expands
 * two extra inputs when it's selected.
 */
export interface Network {
  id: string;
  label: string;
  /** bitcore-lib network name (`mainnet` / `testnet`). */
  network: string;
  /** v1a base URL with trailing slash, e.g. `https://node1.…/v1a/`. */
  fullnodeUrl: string;
  /** Explorer base URL with trailing slash, e.g. `https://explorer.…/`. */
  explorerUrl: string;
}

export const NETWORKS: Network[] = [
  {
    id: 'mainnet',
    label: 'Mainnet',
    network: 'mainnet',
    fullnodeUrl: 'https://node1.mainnet.hathor.network/v1a/',
    explorerUrl: 'https://explorer.hathor.network/',
  },
  {
    id: 'testnet',
    label: 'Testnet (Golf)',
    network: 'testnet',
    fullnodeUrl: 'https://node1.golf.testnet.hathor.network/v1a/',
    explorerUrl: 'https://explorer.testnet.hathor.network/',
  },
  {
    id: 'shielded-testnet',
    label: 'Shielded outputs testnet',
    network: 'testnet',
    fullnodeUrl: 'https://node1.shielded-outputs.testnet.hathor.network/v1a/',
    explorerUrl: 'https://explorer.shielded-outputs.testnet.hathor.network/',
  },
];

/**
 * Build a custom network from form input. `network` defaults to
 * `testnet` because mainnet shielded support hasn't shipped yet — a
 * custom node is overwhelmingly likely to be a dev/test environment.
 */
export function customNetwork(fullnodeUrl: string, explorerUrl: string): Network {
  return {
    id: 'custom',
    label: 'Custom',
    network: 'testnet',
    fullnodeUrl: ensureTrailingSlash(fullnodeUrl),
    explorerUrl: ensureTrailingSlash(explorerUrl),
  };
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}
