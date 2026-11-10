import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import './support/config.mjs';
import {
  checkSessions,
  renewalOutcome,
  secrets,
  sessionLines,
  sessionReport,
} from '../src/jira/commands.mjs';
import { browserTarget } from '../src/core/target.mjs';
import { primary } from './support/config.mjs';

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
      'WARNING: The saved admin session expires in 5 day(s), on 2026-10-28; run forge-test renew admin.',
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

test('a renewal replaces the saved session only when it is still signed in for longer', () => {
  const before = new Date('2026-10-27T21:31:09Z');
  const later = new Date('2026-11-24T23:59:05Z');
  assert.deepEqual(renewalOutcome(before, later, true), { replace: true });
  // A session that recorded no date may be replaced by one that has a date.
  assert.deepEqual(renewalOutcome(null, later, true), { replace: true });
  // Signed out (the site redirected to sign-in), not extended, or no dated sign-in: keep the file.
  assert.equal(renewalOutcome(before, later, false).replace, false);
  assert.match(renewalOutcome(before, later, false).reason, /no longer signed in/);
  // Not extended: a failure within a week of expiring, otherwise current (renewed shortly before).
  const soon = new Date('2026-10-25T21:31:09Z');
  assert.match(renewalOutcome(before, before, true, soon).reason, /not extended/);
  assert.match(renewalOutcome(before, new Date(before - 1), true, soon).reason, /not extended/);
  assert.deepEqual(renewalOutcome(later, later, true, soon), { replace: false, current: true });
  assert.match(renewalOutcome(before, null, true).reason, /no dated sign-in/);
});

test('secrets --sessions-only copies just the named sessions, never the configuration or credentials', (t) => {
  const { authDirectory } = browserTarget();
  mkdirSync(authDirectory, { recursive: true });
  const file = `${authDirectory}/member.json`;
  writeFileSync(
    file,
    JSON.stringify({
      cookies: [cookie('tenant.session.token', '2999-01-01T00:00:00Z')],
      origins: [],
    }),
  );
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  try {
    secrets({
      repo: 'owner/name',
      environment: 'acceptance',
      profiles: ['member'],
      dryRun: true,
      sessionsOnly: true,
    });
  } finally {
    rmSync(file);
  }
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /^Would set JIRA_SESSION_MEMBER \(\d+ bytes; session expires 2999-01-01\)$/,
  );
});

// `sessions` tells which saved session is whose without printing account IDs, and reads nothing
// from Jira unless asked to verify.
function savedSite({ pins = true } = {}) {
  const base = mkdtempSync(`${tmpdir()}/site-`);
  const target = {
    host: primary,
    site: `https://${primary}`,
    directory: `${base}/e2e`,
    authDirectory: `${base}/browser-auth`,
  };
  mkdirSync(target.directory, { recursive: true });
  mkdirSync(target.authDirectory, { recursive: true });
  const save = (profile, iso) =>
    writeFileSync(
      `${target.authDirectory}/${profile}.json`,
      JSON.stringify({ cookies: [cookie('tenant.session.token', iso)], origins: [] }),
    );
  save('admin', '2026-11-20T00:00:00Z');
  save('admin2', '2026-11-21T00:00:00Z');
  save('member', '2026-11-22T00:00:00Z');
  save('restricted', '2026-10-20T00:00:00Z');
  if (pins)
    writeFileSync(
      `${target.directory}/identity-fixture.json`,
      JSON.stringify({
        site: `https://${primary}`,
        project: { id: '10001', key: 'AUTH' },
        scheme: { id: '10002' },
        actors: {
          owner: 'synthetic-owner-1111',
          member: 'synthetic-member-2222',
          restricted: 'synthetic-restricted-3333',
        },
      }),
    );
  return { base, target };
}

test('sessions lists saved dates without asking Jira unless told to verify', async () => {
  const { base, target } = savedSite();
  try {
    const report = await sessionReport(['admin', 'restricted', 'nc-user'], {
      target,
      now,
      ask: assert.fail,
    });
    assert.equal(report.verified, false);
    assert.deepEqual(
      report.sessions.map((s) => [s.profile, s.expires, s.expired ?? null, s.missing ?? false]),
      [
        ['admin', '2026-11-20T00:00:00.000Z', false, false],
        ['restricted', '2026-10-20T00:00:00.000Z', true, false],
        ['nc-user', undefined, null, true],
      ],
    );
    assert.match(report.sessions[0].saved, /^\d{4}-\d{2}-\d{2}T/);
    const lines = sessionLines(report);
    assert.match(lines[0], /^admin: signed in until 2026-11-20, saved \d{4}-\d{2}-\d{2}\.$/);
    assert.match(lines[1], /^restricted: expired 2026-10-20, saved /);
    assert.equal(lines[2], 'nc-user: missing; run forge-test login nc-user.');
    await assert.rejects(sessionReport(['Admin'], { target }), /lowercase profile name/);
  } finally {
    rmSync(base, { recursive: true });
  }
});

test('sessions --verify names the pinned role each account matches, never the account ID', async () => {
  const { base, target } = savedSite();
  // admin2 was signed in as the owner by mistake; member is signed out; restricted has expired.
  const accounts = {
    admin: 'synthetic-owner-1111',
    admin2: 'synthetic-owner-1111',
    member: null,
  };
  const asked = [];
  try {
    const report = await sessionReport([], {
      verify: true,
      target,
      now,
      ask: async (file, site) => {
        const profile = file.split('/').pop().slice(0, -'.json'.length);
        asked.push([profile, site]);
        return accounts[profile];
      },
    });
    assert.deepEqual(asked, [
      ['admin', `https://${primary}`],
      ['admin2', `https://${primary}`],
      ['member', `https://${primary}`],
    ]);
    assert.equal(report.pins, true);
    const verify = Object.fromEntries(report.sessions.map((s) => [s.profile, s.verify]));
    assert.deepEqual(verify.admin, {
      signedIn: true,
      account: '…1111',
      pin: 'owner',
      sameAs: ['admin2'],
    });
    assert.deepEqual(verify.member, { signedIn: false });
    assert.equal(verify.restricted, undefined);
    const text = sessionLines(report).join('\n');
    assert.match(
      text,
      /^admin2: .*; signed in as the pinned owner account \(…1111\); same account as admin\.$/m,
    );
    assert.match(text, /^member: .*; Jira returned no account \(signed out\)\.$/m);
    assert.doesNotMatch(text, /synthetic-/);
  } finally {
    rmSync(base, { recursive: true });
  }
});

test('sessions --verify without pins, or without an answer, says so', async () => {
  const { base, target } = savedSite({ pins: false });
  try {
    const report = await sessionReport(['admin', 'member'], {
      verify: true,
      target,
      now,
      ask: async (file) => {
        if (file.endsWith('/member.json')) throw Error('Jira answered HTTP 500');
        return 'synthetic-owner-1111';
      },
    });
    assert.equal(report.pins, false);
    assert.equal(report.sessions[0].verify.pin, null);
    assert.deepEqual(report.sessions[1].verify, { error: 'Jira answered HTTP 500' });
    const lines = sessionLines(report);
    assert.match(lines[0], /signed in as an unpinned account \(…1111\)\.$/);
    assert.match(lines[1], /not verified \(Jira answered HTTP 500\)\.$/);
    assert.equal(lines[2], 'No identity pins for this site; accounts were not compared.');
  } finally {
    rmSync(base, { recursive: true });
  }
});
