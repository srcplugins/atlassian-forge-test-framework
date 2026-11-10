import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/config.mjs';
import { heldFor, leaseUses } from '../src/jira/site-lease.mjs';
import { leaseSite as site } from './support/lease-site.mjs';

test('a free site is leased, renewed and released', async () => {
  const s = site();
  const lease = s.lease('repo-a');
  await lease.acquire();
  assert.equal(s.property.holder, 'repo-a');
  const expires = s.property.expires;
  s.clock += 60_000;
  await lease.renew();
  assert.ok(s.property.expires > expires);
  await lease.release();
  assert.equal(s.property, undefined);
});

test('a second suite waits for the holder, then proceeds', async () => {
  const s = site();
  const first = s.lease('repo-a');
  await first.acquire();
  let polls = 0;
  const second = s.lease('repo-b', {
    onSleep: async () => {
      if (++polls === 3) await first.release();
    },
  });
  await second.acquire();
  assert.equal(s.property.holder, 'repo-b');
  assert.ok(polls >= 3);
});

test('an expired holder is taken over; a live one makes the waiter give up at the deadline', async () => {
  const s = site();
  await s.lease('crashed').acquire();
  s.clock += 16 * 60_000;
  await s.lease('repo-b').acquire();
  assert.equal(s.property.holder, 'repo-b');
  await assert.rejects(
    () => s.lease('repo-c', { wait: 5 * 60_000 }).acquire(),
    /still in use by repo-b/,
  );
});

test('of two simultaneous writers only the one whose value stayed holds the lease', async () => {
  const s = site();
  const a = s.lease('repo-a');
  // repo-b writes during repo-a's settle pause, so repo-a reads back repo-b and waits.
  let raced = false;
  const b = s.lease('repo-b');
  const aWaits = s.lease('repo-a', {
    wait: 2 * 60_000,
    onSleep: async () => {
      if (!raced) {
        raced = true;
        await b.acquire();
      }
    },
  });
  await assert.rejects(() => aWaits.acquire(), /still in use by repo-b/);
  assert.equal(s.property.holder, 'repo-b');
  await assert.doesNotReject(() => a.release()); // Never held: releases nothing.
  assert.equal(s.deletes, 0);
});

test('a competing write that lands after the first read-back is caught by the second', async () => {
  const s = site();
  // repo-b's write arrives between repo-a's two read-backs (a slow PUT); repo-a must yield.
  let pauses = 0;
  const a = s.lease('repo-a', {
    wait: 2 * 60_000,
    onSleep: async () => {
      if (++pauses === 2) s.property = { id: 'b-id', holder: 'repo-b', expires: s.clock + 900_000 };
    },
  });
  await assert.rejects(() => a.acquire(), /still in use by repo-b/);
  assert.equal(s.property.holder, 'repo-b');
  await a.release();
  assert.equal(s.deletes, 0);
});

test('renew after release does nothing, so an in-flight renewal cannot recreate the lease', async () => {
  const s = site();
  const a = s.lease('repo-a');
  await a.acquire();
  await a.release();
  assert.equal(s.property, undefined);
  await a.renew();
  assert.equal(s.property, undefined);
  await assert.doesNotReject(() => s.lease('repo-b').acquire());
});

test('a lost lease is reported, and release never deletes another holder', async () => {
  const s = site();
  const a = s.lease('repo-a');
  await a.acquire();
  s.clock += 16 * 60_000;
  await s.lease('repo-b').acquire();
  await assert.rejects(
    () => a.renew(),
    (error) => error.leaseLost === true,
  );
  await a.release();
  assert.equal(s.property.holder, 'repo-b');
  assert.equal(s.deletes, 0);
});

test('the lease is written only to a marked fixture space', async () => {
  const s = site({ description: 'A customer project' });
  await assert.rejects(() => s.lease('repo-a').acquire(), /not a marked fixture space/);
  assert.equal(s.writes, 0);
});

test('a lane sees a live lease held by someone else, never its own suite’s, without writing', async () => {
  const s = site();
  const lane = s.lease('a lane');
  assert.equal(await lane.heldByOther(), null);
  const suite = s.lease('org/plugin run 7');
  await suite.acquire();
  const writes = s.writes;
  assert.equal(await lane.heldByOther(), 'org/plugin run 7');
  assert.equal(await lane.heldByOther(suite.id), null);
  s.clock += 16 * 60_000;
  assert.equal(await lane.heldByOther(), null);
  assert.equal(s.writes, writes);
});

test('a waiting priority run goes ahead of other waiters, and the holder can see it waiting', async () => {
  const s = site();
  const holder = s.lease('copy run');
  await holder.acquire();
  assert.equal(await holder.priorityWaiting(), null);
  let first = true;
  const release = s.lease('release run', {
    priority: true,
    onSleep: async () => {
      if (!first) return;
      first = false;
      assert.equal(s.reservation.holder, 'release run');
      assert.equal(await holder.priorityWaiting(), 'release run');
      await holder.release();
      // The site is free, but another waiter leaves it to the reservation.
      await assert.rejects(
        () => s.lease('other copy run').acquire({ wait: 0 }),
        /^Error: The site is reserved for release run, which goes first; try again later\.$/,
      );
      assert.equal(s.property, undefined);
    },
  });
  await release.acquire();
  assert.equal(s.property.holder, 'release run');
  assert.equal(s.reservation, undefined);
});

test('a priority holder never gives way, and an expired reservation holds nothing', async () => {
  const s = site();
  const release = s.lease('release run', { priority: true });
  assert.equal(await release.priorityWaiting(), null); // Not held yet.
  await release.acquire();
  s.reservation = { id: 'other-id', holder: 'another release', expires: s.clock + 90_000 };
  assert.equal(await release.priorityWaiting(), null);
  await release.release();
  // A waiter that gave up stops renewing, so its reservation lapses within a few polls.
  s.reservation.expires = s.clock - 1;
  const copy = s.lease('copy run');
  await copy.acquire();
  assert.equal(s.property.holder, 'copy run');
  assert.equal(await copy.priorityWaiting(), null);
});

test('waiters take a free site in the order they arrived', async () => {
  const s = site();
  s.clock = 100_000;
  const holder = s.lease('repo-h');
  await holder.acquire();
  // repo-a asked first and is still polling; repo-b arrives later.
  s.waiters.set('acme.site-lease-wait-a', {
    id: 'a',
    holder: 'repo-a',
    joined: s.clock - 1000,
    expires: s.clock + 90_000,
  });
  const arrived = s.clock;
  const logs = [];
  let polls = 0;
  const b = s.lease('repo-b', {
    log: (line) => logs.push(line),
    onSleep: async () => {
      polls++;
      if (polls === 1) {
        const mine = [...s.waiters.values()].find((w) => w.holder === 'repo-b');
        assert.ok(mine && mine.joined === arrived, 'repo-b queues while it waits');
        await holder.release();
      }
      // repo-a keeps its entry alive until it has had the site.
      if (polls < 4) s.waiters.get('acme.site-lease-wait-a').expires = s.clock + 90_000;
      if (polls === 4) s.waiters.delete('acme.site-lease-wait-a');
    },
  });
  await b.acquire();
  assert.equal(s.property.holder, 'repo-b');
  assert.ok(polls >= 4, 'repo-b left the free site to repo-a');
  assert.deepEqual(logs, [
    'Waiting for repo-h, which has held it for less than a minute, to finish on this site (up to 2 h 0 min).',
    'Waiting for repo-a, which asked for this site first.',
  ]);
  assert.equal(s.waiters.size, 0, 'repo-b removed its entry once it held the site');
});

test('a lane leaves a free site to a queued waiter; a lapsed entry holds nothing and is deleted', async () => {
  const s = site();
  s.clock = 100_000;
  s.waiters.set('acme.site-lease-wait-a', {
    id: 'a',
    holder: 'repo-a',
    joined: s.clock - 1000,
    expires: s.clock + 90_000,
  });
  await assert.rejects(
    () => s.lease('a lane').acquire({ wait: 0 }),
    /^Error: repo-a is waiting for the site and goes first; try again later\.$/,
  );
  assert.equal(s.property, undefined);
  assert.equal(s.waiters.size, 1, 'a refusing lane never queues');
  s.clock += 91_000; // repo-a was killed and stopped renewing.
  await s.lease('a lane').acquire({ wait: 0 });
  assert.equal(s.property.holder, 'a lane');
  assert.equal(s.waiters.size, 0);
});

test('a waiter that gives up removes its entry, and a resumed suite keeps its place', async () => {
  const s = site();
  const holder = s.lease('repo-h');
  await holder.acquire();
  await assert.rejects(
    () => s.lease('repo-b', { wait: 2 * 60_000 }).acquire(),
    /still in use by repo-h/,
  );
  assert.equal(s.waiters.size, 0);
  // repo-h pauses for another run, then asks again; repo-c arrived meanwhile and is waiting.
  await holder.release();
  s.clock += 60_000;
  s.waiters.set('acme.site-lease-wait-c', {
    id: 'c',
    holder: 'repo-c',
    joined: s.clock,
    expires: s.clock + 90_000,
  });
  await holder.acquire({ wait: 0 });
  assert.equal(s.property.holder, 'repo-h');
});

test('the lease records when it was taken, and renewals keep that time', async () => {
  const s = site();
  s.clock = 1_000_000;
  const lease = s.lease('repo-a');
  await lease.acquire();
  const since = s.property.since;
  assert.equal(since, 1_000_000);
  s.clock += 10 * 60_000;
  await lease.renew();
  assert.equal(s.property.since, since);
});

test('a waiter logs, and its refusal names, the holder and how long it has held the site', async () => {
  const s = site();
  const holder = s.lease('org/plugin run 7');
  await holder.acquire();
  s.clock += 12 * 60_000 - 6000; // Less the acquire's two settle pauses.
  await holder.renew(); // As the holder's timer does while it runs.
  const logs = [];
  await assert.rejects(
    () => s.lease('repo-b', { wait: 5 * 60_000, log: (line) => logs.push(line) }).acquire(),
    (error) => {
      assert.equal(
        error.message,
        'The site is still in use by org/plugin run 7, which has held it for 17 minutes; try again later.',
      );
      assert.equal(error.siteBusy, true);
      return true;
    },
  );
  assert.deepEqual(logs, [
    'Waiting for org/plugin run 7, which has held it for 12 minutes, to finish on this site (up to 5 minutes).',
  ]);
});

test('status reads the live holder without writing, and is null when the site is free', async () => {
  const s = site();
  const lease = s.lease('repo-a');
  assert.equal(await lease.status(), null);
  s.clock = 5_000;
  await lease.acquire();
  s.clock += 3 * 60_000;
  s.reservation = { id: 'r', holder: 'release run', expires: s.clock + 90_000 };
  const writes = s.writes;
  const observer = s.lease('a status command');
  assert.deepEqual(await observer.status(), {
    holder: 'repo-a',
    since: 5_000,
    heldMs: 3 * 60_000 + 6000,
    expires: s.property.expires,
    own: false,
    priorityWaiting: 'release run',
    holders: [{ holder: 'repo-a', uses: null, since: 5_000, expires: s.property.expires }],
  });
  assert.equal((await lease.status()).own, true);
  assert.equal((await observer.status(lease.id)).own, true);
  assert.equal(s.writes, writes);
  // A lease written by an earlier version has no start time.
  delete s.property.since;
  assert.equal((await observer.status()).heldMs, null);
  s.clock += 16 * 60_000;
  assert.equal(await observer.status(), null);
});

test('held durations read as words', () => {
  assert.equal(heldFor(30_000), 'less than a minute');
  assert.equal(heldFor(60_000), '1 minute');
  assert.equal(heldFor(59 * 60_000), '59 minutes');
  assert.equal(heldFor(125 * 60_000), '2 h 5 min');
  assert.equal(heldFor(null), 'an unknown time');
  assert.equal(heldFor(-1), 'an unknown time');
});

// Runs that declare what they use share the site with runs that use other things.
const fh = ['app:filter-history'];
const lh = ['app:label-history', 'confluence:PLSLABEL'];
const pch = ['app:page-copy-history', 'confluence:PLSLABEL'];

test('runs that use different things hold the site together; a whole-site run waits for both', async () => {
  const s = site();
  const a = s.lease('filter history', { uses: fh });
  const b = s.lease('label history', { uses: lh });
  await a.acquire();
  await b.acquire({ wait: 0 });
  assert.equal(s.sharing.size, 2);
  assert.equal(s.property, undefined, 'sharing runs leave the whole-site lease alone');
  await assert.rejects(
    () => s.lease('agent prompts').acquire({ wait: 0 }),
    /still in use by filter history/,
  );
  await a.release();
  await b.release();
  assert.equal(s.sharing.size, 0);
  await s.lease('agent prompts').acquire({ wait: 0 });
  assert.equal(s.property.holder, 'agent prompts');
});

test('runs that use the same thing take turns, and a whole-site holder blocks every sharing run', async () => {
  const s = site();
  const label = s.lease('label history', { uses: lh });
  await label.acquire();
  await assert.rejects(
    () => s.lease('page copy history', { uses: pch }).acquire({ wait: 0 }),
    /still in use by label history/,
  );
  await label.release();
  const whole = s.lease('agent prompts');
  await whole.acquire();
  await assert.rejects(
    () => s.lease('filter history', { uses: fh }).acquire({ wait: 0 }),
    /still in use by agent prompts/,
  );
  assert.equal(s.sharing.size, 0, 'a refused run leaves no entry behind');
});

test('between a sharing run and a whole-site run that write at once, the first writer keeps the site', async () => {
  // The sharing run writes first; the whole-site run arrives during its settle pause.
  let s = site();
  s.clock = 1000;
  let raced = false;
  const late = s.lease('agent prompts', { wait: 0 });
  const early = s.lease('filter history', {
    uses: fh,
    onSleep: async () => {
      if (raced) return;
      raced = true;
      await assert.rejects(() => late.acquire(), /still in use by filter history/);
    },
  });
  await early.acquire();
  assert.equal(s.sharing.size, 1);
  assert.equal(s.property, undefined, 'the later whole-site run stepped back');

  // The whole-site run writes first; a sharing run lands during its settle pause.
  s = site();
  s.clock = 1000;
  raced = false;
  const sharer = s.lease('filter history', { uses: fh, wait: 0 });
  const whole = s.lease('agent prompts', {
    onSleep: async () => {
      if (raced) return;
      raced = true;
      await assert.rejects(() => sharer.acquire(), /still in use by agent prompts/);
    },
  });
  await whole.acquire();
  assert.equal(s.property.holder, 'agent prompts');
  assert.equal(s.sharing.size, 0, 'the later sharing run stepped back');
});

test('of two conflicting sharing runs that write at once, the first keeps the site', async () => {
  const s = site();
  s.clock = 1000;
  let raced = false;
  const late = s.lease('page copy history', { uses: pch, wait: 0 });
  const early = s.lease('label history', {
    uses: lh,
    onSleep: async () => {
      if (raced) return;
      raced = true;
      s.clock += 10;
      await assert.rejects(() => late.acquire(), /still in use by label history/);
    },
  });
  await early.acquire();
  assert.deepEqual(
    [...s.sharing.values()].map((value) => value.holder),
    ['label history'],
  );
});

test('a sharing holder renews and releases only its own entry, and notices when it is gone', async () => {
  const s = site();
  const a = s.lease('filter history', { uses: fh });
  await a.acquire();
  const [key] = s.sharing.keys();
  const { expires, since } = s.sharing.get(key);
  s.clock += 60_000;
  await a.renew();
  assert.ok(s.sharing.get(key).expires > expires);
  assert.equal(s.sharing.get(key).since, since);
  s.sharing.delete(key);
  await assert.rejects(
    () => a.renew(),
    (error) => error.leaseLost === true,
  );
});

test('a priority run waits only for runs it conflicts with, and only they give way to it', async () => {
  const s = site();
  const label = s.lease('label history', { uses: lh });
  await label.acquire();
  const filter = s.lease('filter history', { uses: fh });
  await filter.acquire();
  s.reservation = { id: 'r', holder: 'page copy release', uses: pch, expires: s.clock + 90_000 };
  assert.equal(await label.priorityWaiting(), 'page copy release');
  assert.equal(await filter.priorityWaiting(), null);
  // A run that doesn't conflict with the reservation isn't held back by it.
  await s.lease('board history', { uses: ['app:board-history'] }).acquire({ wait: 0 });
  assert.equal(s.sharing.size, 3);
});

test('status names the first conflicting holder, else this run’s own, and lists every holder', async () => {
  const s = site();
  const suite = s.lease('org/filter-history run 7', { uses: fh });
  await suite.acquire();
  await s.lease('label history', { uses: lh }).acquire();
  const lane = s.lease('a lane', { uses: fh });
  const status = await lane.status(suite.id);
  assert.equal(status.holder, 'org/filter-history run 7');
  assert.equal(status.own, true);
  assert.deepEqual(
    status.holders.map((value) => [value.holder, value.uses]),
    [
      ['org/filter-history run 7', fh],
      ['label history', lh],
    ],
  );
  // From another suite of the same app, the same holder conflicts.
  assert.equal((await lane.status('another-suite')).own, false);
  assert.equal(await lane.heldByOther(suite.id), null);
  assert.equal(await lane.heldByOther(), 'org/filter-history run 7');
  // A whole-site observer (forge-test lease) sees the first holder.
  assert.equal((await s.lease('a status command').status()).holder, 'org/filter-history run 7');
});

test('declared uses are "<kind>:<name>" entries; none means the whole site', () => {
  assert.equal(leaseUses(undefined), null);
  assert.deepEqual(leaseUses(['confluence:PLSLABEL', 'app:x', 'app:x']), [
    'app:x',
    'confluence:PLSLABEL',
  ]);
  for (const bad of [[], 'app:x', ['x'], ['app:'], ['App:x'], ['app:x y']])
    assert.throws(() => leaseUses(bad), /leaseUses is a non-empty list/);
});

test('a value written at the same moment by a conflicting run decides by start time', async () => {
  // A whole-site run's write that lands during a sharing run's settle, with a later start: the
  // sharing run keeps the site (the whole-site run steps back on its own check).
  let s = site();
  s.clock = 1000;
  let landed = false;
  const sharer = s.lease('filter history', {
    uses: fh,
    onSleep: async () => {
      if (landed) return;
      landed = true;
      s.property = { id: 'w', holder: 'agent prompts', since: s.clock, expires: s.clock + 900_000 };
    },
  });
  await sharer.acquire();
  assert.equal(s.sharing.size, 1);

  // The same write with an earlier start wins: the sharing run steps back and waits.
  s = site();
  s.clock = 1000;
  landed = false;
  const loser = s.lease('filter history', {
    uses: fh,
    wait: 60_000,
    onSleep: async () => {
      if (landed) return;
      landed = true;
      s.property = { id: 'w', holder: 'agent prompts', since: 0, expires: s.clock + 900_000 };
    },
  });
  await assert.rejects(() => loser.acquire(), /still in use by agent prompts/);
  assert.equal(s.sharing.size, 0, 'the sharing run removed its entry');

  // A sharing entry with a later start that lands during a whole-site run's settle: the
  // whole-site run waits for it to step back, then keeps the site.
  s = site();
  s.clock = 1000;
  let pauses = 0;
  const whole = s.lease('agent prompts', {
    onSleep: async () => {
      pauses++;
      if (pauses === 1)
        s.sharing.set('acme.site-lease-use-x', {
          id: 'x',
          holder: 'filter history',
          uses: fh,
          since: s.clock,
          expires: s.clock + 900_000,
        });
      if (pauses === 3) s.sharing.delete('acme.site-lease-use-x');
    },
  });
  await whole.acquire();
  assert.equal(s.property.holder, 'agent prompts');
  assert.ok(pauses >= 3);
});
