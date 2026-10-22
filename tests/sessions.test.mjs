import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import './support/config.mjs';
import { checkSessions } from '../src/jira/commands.mjs';

// Saved sessions are checked before a run signs in with them: a lapsed sign-in must refuse the run with what to do, never show up as a failing test.
const now = new Date('2026-10-22T12:00:00Z');
const at = (iso) => Date.parse(iso) / 1000;
function sessions(files) {
  const directory = mkdtempSync(`${tmpdir()}/sessions-`);
  for (const [name, cookies] of Object.entries(files))
    writeFileSync(`${directory}/${name}.json`, JSON.stringify({ cookies, origins: [] }));
  return directory;
}
const cookie = (name, iso) => ({ name, value: 'synthetic', expires: iso ? at(iso) : -1 });

test('a session that has expired refuses the run and says how to renew it', () => {
  const directory = sessions({
    admin: [cookie('tenant.session.token', '2026-12-01T00:00:00Z')],
    member: [
      cookie('cloud.session.token', '2026-10-21T08:00:00Z'),
      cookie('tenant.session.token', '2026-11-30T00:00:00Z'),
    ],
  });
  try {
    assert.throws(
      () => checkSessions(directory, { now, env: {}, warn: assert.fail }),
      /^Error: The saved member session expired on 2026-10-21; run forge-test login member\.$/,
    );
    assert.throws(
      () => checkSessions(directory, { now, env: { GITHUB_ACTIONS: 'true' }, warn: assert.fail }),
      /member session expired on 2026-10-21; run forge-test login member on the machine that keeps the sessions, then forge-test secrets\./,
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('a session expiring within a week warns, as an annotation on a GitHub runner', () => {
  const directory = sessions({
    admin: [cookie('cloud.session.token', '2026-10-28T11:00:00Z')],
    member: [cookie('cloud.session.token', '2026-10-29T13:00:00Z')],
    restricted: [cookie('other', '2026-10-23T00:00:00Z'), cookie('tenant.session.token')],
  });
  try {
    const warnings = [];
    const found = checkSessions(directory, { now, env: {}, warn: (m) => warnings.push(m) });
    assert.deepEqual(warnings, [
      'WARNING: The saved admin session expires in 5 day(s), on 2026-10-28; run forge-test login admin.',
    ]);
    // Seven days ahead is not yet within a week; a session cookie with no date never warns.
    assert.deepEqual(
      found.map((s) => [s.profile, s.expires?.toISOString() ?? null]),
      [
        ['admin', '2026-10-28T11:00:00.000Z'],
        ['member', '2026-10-29T13:00:00.000Z'],
        ['restricted', null],
      ],
    );
    warnings.length = 0;
    checkSessions(directory, {
      now,
      env: { GITHUB_ACTIONS: 'true' },
      warn: (m) => warnings.push(m),
    });
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0],
      /^::warning title=Saved session expiring::The saved admin session expires in 5 day\(s\)/,
    );
    assert.doesNotMatch(warnings[0], /synthetic/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('no saved sessions, or an unreadable one, is left to the sign-in that needs it', () => {
  assert.deepEqual(checkSessions(`${tmpdir()}/no-such-sessions-${process.pid}`, { now }), []);
  const directory = mkdtempSync(`${tmpdir()}/sessions-`);
  try {
    writeFileSync(`${directory}/admin.json`, '{not json');
    assert.deepEqual(checkSessions(directory, { now, warn: assert.fail }), [
      { profile: 'admin', expires: null },
    ]);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
