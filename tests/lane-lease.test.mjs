import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/config.mjs';
import { lane, laneLease, leaseHolder, leaseReport, stopOnSignal } from '../src/jira/commands.mjs';
import { leaseSite } from './support/lease-site.mjs';

// A lane shares the fixture spaces of every run on the site, so it holds the site lease while it
// runs and refuses at once while another run holds it. A suite's own lanes run under its lease.
// The holder's name comes from the environment; drop the runner's own so CI names "a local lane".
const local = (env) => ({
  ...env,
  GITHUB_REPOSITORY: undefined,
  GITHUB_RUN_ID: undefined,
  FORGE_TEST_LEASE_HOLDER: undefined,
});
const hold =
  (s, extra = {}) =>
  (env) =>
    laneLease(local(env), { api: s.api, lease: s.factory, log: () => {}, ...extra });

test('a lane refuses at once while another run holds the site, naming it and for how long', async () => {
  const s = leaseSite();
  const suite = s.lease('org/plugin run 7');
  await suite.acquire();
  s.clock += 25 * 60_000 - 6000; // Less the acquire's two settle pauses.
  await suite.renew();
  let ran = false;
  await assert.rejects(
    () => lane('features', [], { hold: hold(s), run: async () => (ran = true) }),
    /^Error: The site is in use by org\/plugin run 7, which has held it for 25 minutes; run the lane when it finishes \(forge-test lease shows the holder\)\.$/,
  );
  assert.equal(ran, false);
  assert.equal(s.property.holder, 'org/plugin run 7');
});

test('a lane holds the site while Playwright runs and releases it after, even on failure', async () => {
  for (const exit of [0, 1]) {
    const s = leaseSite();
    const seen = [];
    const code = await lane('features', ['--grep', 'X'], {
      hold: hold(s),
      run: async (args, env) => {
        seen.push({ holder: s.property?.holder, lane: env.E2E_LANE, args: args.slice(1) });
        // Meanwhile a suite elsewhere would wait, and another lane would refuse.
        await assert.rejects(
          () => s.lease('other').acquire({ wait: 0 }),
          /still in use by a local lane/,
        );
        return exit;
      },
    });
    assert.equal(code, exit);
    assert.deepEqual(seen, [
      {
        holder: 'a local lane',
        lane: 'features',
        args: ['test', '-c', 'playwright.config.mjs', '--project=features', '--grep', 'X'],
      },
    ]);
    assert.equal(s.property, undefined);
  }
});

test('a stop signal marks the run stopped; a second releases the lease at once and exits', async () => {
  const process = new EventEmitter();
  const exits = [];
  let released = 0;
  const logs = [];
  const signals = stopOnSignal(async () => released++, {
    on: process,
    exit: (code) => exits.push(code),
    log: (line) => logs.push(line),
  });
  assert.equal(signals.stopped(), null);
  process.emit('SIGINT', 'SIGINT');
  assert.equal(signals.stopped(), 'SIGINT');
  assert.equal(released, 0, 'the first signal leaves the step to end on its own');
  process.emit('SIGTERM', 'SIGTERM');
  process.emit('SIGTERM', 'SIGTERM');
  await new Promise((done) => setImmediate(done));
  assert.equal(released, 1);
  assert.deepEqual(exits, [143]);
  assert.match(logs[0], /^SIGINT: stopping after the current step/);
  signals.dispose();
  assert.equal(process.listenerCount('SIGINT'), 0);
  assert.equal(process.listenerCount('SIGTERM'), 0);
});

test('a stopped lane releases the site at once on a second signal', async () => {
  const s = leaseSite();
  const process = new EventEmitter();
  const exits = [];
  const onSignal = (stop, options) =>
    stopOnSignal(stop, { ...options, on: process, exit: (code) => exits.push(code) });
  const release = await hold(s, { onSignal })({});
  assert.equal(s.property.holder, 'a local lane');
  process.emit('SIGINT', 'SIGINT');
  assert.equal(s.property.holder, 'a local lane');
  process.emit('SIGINT', 'SIGINT');
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(s.property, undefined);
  assert.deepEqual(exits, [130]);
  await release(); // The lane's own release afterwards does nothing more.
  assert.equal(process.listenerCount('SIGINT'), 0);
  assert.equal(s.deletes, 1);
});

test('a lane renews the lease while it runs', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const s = leaseSite();
  const release = await hold(s, { renewEvery: 1000 })({});
  const expires = s.property.expires;
  s.clock += 60_000;
  t.mock.timers.tick(1000);
  await new Promise((done) => setImmediate(done));
  assert.ok(s.property.expires > expires);
  await release();
  assert.equal(s.property, undefined);
});

test('a suite’s own lane runs under its lease; another holder still refuses it', async () => {
  const s = leaseSite();
  const suite = s.lease('org/plugin run 7');
  await suite.acquire();
  const writes = s.writes;
  const release = await hold(s)({ FORGE_TEST_LEASE: suite.id });
  await release();
  assert.equal(s.writes, writes);
  assert.equal(s.property.holder, 'org/plugin run 7');
  await assert.rejects(
    () => hold(s)({ FORGE_TEST_LEASE: 'another-suite' }),
    /in use by org\/plugin run 7/,
  );
});

test('an unknown lane is refused before the lease is read', async () => {
  await assert.rejects(
    () => lane('nope', [], { hold: assert.fail }),
    /Usage: forge-test lane <features\|compatibility>/,
  );
});

test('the lease holder label names the CI run, a chosen name, or the kind of local run', () => {
  assert.equal(
    leaseHolder('suite', { GITHUB_REPOSITORY: 'org/plugin', GITHUB_RUN_ID: '7' }),
    'org/plugin run 7',
  );
  assert.equal(leaseHolder('lane', {}), 'a local lane');
  assert.equal(
    leaseHolder('lane', { FORGE_TEST_LEASE_HOLDER: 'agent session 2' }),
    'agent session 2 (lane)',
  );
  assert.throws(
    () => leaseHolder('lane', { FORGE_TEST_LEASE_HOLDER: 'x\ny' }),
    /FORGE_TEST_LEASE_HOLDER/,
  );
});

test('forge-test lease reports the holder in words or JSON', () => {
  assert.equal(leaseReport(null), 'The site lease is free.');
  assert.equal(leaseReport(null, { json: true }), '{"held":false}');
  const status = {
    holder: 'org/plugin run 7',
    since: Date.UTC(2030, 0, 1, 10, 0),
    heldMs: 42 * 60_000,
    expires: Date.UTC(2030, 0, 1, 10, 51),
    own: false,
    priorityWaiting: 'org/plugin run 9',
  };
  assert.equal(
    leaseReport(status, { now: Date.UTC(2030, 0, 1, 10, 42) }),
    'The site lease is held by org/plugin run 7, for 42 minutes; it lapses in 9 minutes unless renewed.\norg/plugin run 9 is waiting to go first.',
  );
  assert.deepEqual(JSON.parse(leaseReport(status, { json: true })), {
    held: true,
    holder: 'org/plugin run 7',
    since: '2030-01-01T10:00:00.000Z',
    heldMinutes: 42,
    expires: '2030-01-01T10:51:00.000Z',
    priorityWaiting: 'org/plugin run 9',
    holders: [
      {
        holder: 'org/plugin run 7',
        uses: null,
        since: '2030-01-01T10:00:00.000Z',
        expires: '2030-01-01T10:51:00.000Z',
      },
    ],
  });
  // Runs sharing the site are each listed with what they use.
  const shared = {
    ...status,
    priorityWaiting: null,
    holders: [
      { ...status, uses: ['app:filter-history'] },
      {
        ...status,
        holder: 'a local lane',
        since: Date.UTC(2030, 0, 1, 10, 40),
        uses: ['confluence:PLSLABEL'],
      },
    ],
  };
  assert.equal(
    leaseReport(shared, { now: Date.UTC(2030, 0, 1, 10, 42) }),
    [
      'The site is shared by 2 runs:',
      '- org/plugin run 7 (sharing: app:filter-history), for 42 minutes; it lapses in 9 minutes unless renewed.',
      '- a local lane (sharing: confluence:PLSLABEL), for 2 minutes; it lapses in 9 minutes unless renewed.',
    ].join('\n'),
  );
});
