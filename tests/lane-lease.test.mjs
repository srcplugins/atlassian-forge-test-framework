import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/config.mjs';
import { lane, laneLease, leaseHolder, leaseReport } from '../src/jira/commands.mjs';
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
  });
});
