import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environmentId, primary, second } from './support/config.mjs';
import { maskValues } from '../src/jira/commands.mjs';

// A public CI log masks every owned host, environment ID and fixture project key from the
// private configuration (tests/support/config.mjs).
test('mask covers owned hosts, environment IDs and every fixture project key', () => {
  const masked = maskValues();
  for (const value of [primary, second, environmentId, 'DEMO', 'SBOX', 'ISO', 'AUTH', 'DEV'])
    assert.ok(masked.includes(value), value);
  assert.equal(new Set(masked).size, masked.length, 'no duplicates');
  assert.ok(
    masked.every((value) => value.length >= 3),
    'nothing short enough to blank ordinary text',
  );
});
