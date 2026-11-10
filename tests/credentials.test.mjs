import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/config.mjs';
import { config, configure } from '../src/core/config.mjs';
import { atlassianCredentials, requireCredentials } from '../src/core/credentials.mjs';

// On Linux the token comes from the Secret Service through secret-tool. A stand-in on PATH
// answers for one service name and fails for any other, like a missing item.
test(
  'the token comes from the environment, else the Secret Service item, else nowhere',
  { skip: process.platform !== 'linux' },
  (t) => {
    const bin = mkdtempSync(join(tmpdir(), 'forge-test-keyring-'));
    t.after(() => rmSync(bin, { recursive: true, force: true }));
    writeFileSync(
      join(bin, 'secret-tool'),
      '#!/bin/sh\n[ "$*" = "lookup service acme-token" ] && echo stored-token && exit 0\nexit 1\n',
    );
    chmodSync(join(bin, 'secret-tool'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    t.after(() => (process.env.PATH = path));
    const base = config();
    t.after(() => configure(base));

    configure({ ...base, keychainService: 'acme-token' });
    assert.equal(atlassianCredentials({}).token, 'stored-token');
    assert.equal(atlassianCredentials({ ATLASSIAN_API_TOKEN: 'from-env' }).token, 'from-env');
    configure({ ...base, keychainService: 'other' });
    assert.equal(atlassianCredentials({}).token, undefined);
    configure(base);
    assert.equal(atlassianCredentials({}).token, undefined);
    process.env.PATH = '/nonexistent';
    configure({ ...base, keychainService: 'acme-token' });
    assert.equal(atlassianCredentials({}).token, undefined);
  },
);

// One name pair: the names the Forge CLI itself reads are never an input here.
test('only ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN name the account', () => {
  const forge = { FORGE_EMAIL: 'forge@example.com', FORGE_API_TOKEN: 'forge-token' };
  assert.deepEqual(atlassianCredentials(forge), { email: undefined, token: undefined });
  const account = { ATLASSIAN_EMAIL: 'a@example.com', ATLASSIAN_API_TOKEN: 'token' };
  assert.deepEqual(atlassianCredentials({ ...forge, ...account }), {
    email: 'a@example.com',
    token: 'token',
  });
});

test('a missing credential fails naming the variable to set', () => {
  const account = { ATLASSIAN_EMAIL: 'a@example.com', ATLASSIAN_API_TOKEN: 'token' };
  assert.deepEqual(requireCredentials(account), { email: 'a@example.com', token: 'token' });
  assert.throws(
    () => requireCredentials({}),
    /^Error: Set ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN\.$/,
  );
  assert.throws(
    () => requireCredentials({ ATLASSIAN_EMAIL: 'a@example.com' }),
    /^Error: Set ATLASSIAN_API_TOKEN\.$/,
  );
  assert.throws(
    () => requireCredentials({ ATLASSIAN_API_TOKEN: 'token' }),
    /^Error: Set ATLASSIAN_EMAIL\.$/,
  );
});
