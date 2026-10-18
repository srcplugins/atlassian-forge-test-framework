import { test } from 'node:test';
import assert from 'node:assert/strict';
import { primary, second } from './support/config.mjs';
import {
  daysUntilExpiry,
  fixtureApps,
  fixtureProject,
  identityProjectKey,
  landingIssue,
  ownedSites,
  siteFor,
  validateConfig,
} from '../src/core/config.mjs';

const valid = {
  namespace: 'acme',
  sites: [{ role: 'primary', host: primary }],
  installations: [],
  fixtures: { apps: { 'demo-app': 'DEMO' } },
};

test('configured sites, fixtures and expiry are read by role and name', () => {
  assert.deepEqual(ownedSites(), [primary, second]);
  assert.equal(siteFor('isolation'), second);
  assert.throws(() => siteFor('missing'), /No owned site/);
  assert.deepEqual(fixtureApps(), { 'demo-app': 'DEMO', 'forge-sandbox': 'SBOX' });
  assert.equal(fixtureProject('tenant-isolation'), 'ISO');
  assert.throws(() => fixtureProject('unknown'), /No fixture space/);
  assert.equal(identityProjectKey(), 'AUTH');
  assert.equal(landingIssue(), 'DEV-1');
  assert.equal(daysUntilExpiry(primary, new Date('2998-12-31T00:00:00Z')), 1);
  assert.equal(daysUntilExpiry(second), null);
});

test('validation refuses unowned shapes without echoing values', () => {
  assert.doesNotThrow(() => validateConfig(valid));
  for (const change of [
    { namespace: 'Bad Name' },
    { sites: [] },
    { sites: [{ role: 'primary', host: 'evil.example.com' }] },
    { sites: [{ role: 'primary', host: '../outside' }] },
    {
      sites: [
        { role: 'primary', host: primary },
        { role: 'primary', host: second },
      ],
    },
    { installations: [{ app: 'x', site: second, environment: 'development', environmentId: 'a' }] },
    { installations: [{ app: 'x', site: primary, environment: 'prod', environmentId: 'a' }] },
    { fixtures: { apps: { 'demo-app': 'lowercase' } } },
    { fixtures: { landing: 'NOTANISSUE' } },
    { legacyNamespaces: [{ slug: 'old' }] },
  ])
    assert.throws(
      () => validateConfig({ ...valid, ...change }),
      (error) =>
        /Invalid forge-test configuration/.test(error.message) && !error.message.includes('evil'),
    );
});
