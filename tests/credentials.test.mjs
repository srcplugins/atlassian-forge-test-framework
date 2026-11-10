import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/config.mjs';
import { config, configure } from '../src/core/config.mjs';
import { atlassianCredentials } from '../src/core/credentials.mjs';

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
    assert.equal(atlassianCredentials({ JIRA_API_KEY: 'from-env' }).token, 'from-env');
    const both = { ATLASSIAN_API_TOKEN: 'neutral', JIRA_API_KEY: 'older' };
    assert.equal(atlassianCredentials(both).token, 'neutral');
    assert.equal(atlassianCredentials({ ATLASSIAN_EMAIL: 'a@x', JIRA_EMAIL: 'j@x' }).email, 'a@x');
    configure({ ...base, keychainService: 'other' });
    assert.equal(atlassianCredentials({}).token, undefined);
    configure(base);
    assert.equal(atlassianCredentials({}).token, undefined);
    process.env.PATH = '/nonexistent';
    configure({ ...base, keychainService: 'acme-token' });
    assert.equal(atlassianCredentials({}).token, undefined);
  },
);
