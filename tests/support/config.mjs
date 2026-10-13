import { configure } from '../../src/core/config.mjs';

// A synthetic configuration for offline tests. No real site, account or ID appears in tests.
export const primary = 'primary-example.atlassian.net';
export const second = 'second-example.atlassian.net';
export const legacy = { slug: 'old-acme', brand: 'Old Acme', runPrefix: 'oa' };
export const environmentId = '11111111-2222-4333-8444-555555555555';
configure({
  namespace: 'acme',
  legacyNamespaces: [legacy],
  sites: [
    { role: 'primary', host: primary, expiresOn: '2999-01-01' },
    { role: 'isolation', host: second },
  ],
  installations: [
    { app: 'demo-app', site: primary, environment: 'development', environmentId },
    { app: 'demo-app', site: second, environment: 'production', environmentId },
  ],
  fixtures: {
    apps: { 'demo-app': 'DEMO', 'forge-sandbox': 'SBOX' },
    projects: { 'tenant-isolation': 'ISO' },
    identity: 'AUTH',
    landing: 'DEV-1',
  },
  state: '.local/test-state',
});
