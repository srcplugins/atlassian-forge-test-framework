import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/config.mjs';
import { heldFor } from '../src/jira/site-lease.mjs';
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
