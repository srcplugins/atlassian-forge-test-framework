import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/config.mjs';
import { markers } from '../src/core/markers.mjs';
import { siteLease } from '../src/jira/site-lease.mjs';

const path = '/project/AUTH/properties/acme.site-lease';

// One shared Jira site: the identity space and its lease property, with a manual clock.
function site({ description = markers.identityProject } = {}) {
  const s = { clock: 0, property: undefined, writes: 0, deletes: 0 };
  s.api = async (url, method = 'GET', data) => {
    if (url === '/project/AUTH') return { key: 'AUTH', description };
    assert.equal(url, path);
    if (method === 'PUT') {
      s.writes++;
      s.property = structuredClone(data);
      return null;
    }
    if (method === 'DELETE') {
      s.deletes++;
      s.property = undefined;
      return null;
    }
    return s.property === undefined ? null : { value: structuredClone(s.property) };
  };
  s.lease = (holder, extra = {}) =>
    siteLease(s.api, {
      holder,
      now: () => s.clock,
      sleep: async (ms) => {
        s.clock += ms;
        await extra.onSleep?.();
      },
      log: () => {},
      ...extra,
    });
  return s;
}

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
