import assert from 'node:assert/strict';
import { markers } from '../../src/core/markers.mjs';
import { siteLease } from '../../src/jira/site-lease.mjs';

const leasePath = '/project/AUTH/properties/acme.site-lease';
const next = `${leasePath}-next`;
const waitPrefix = `${leasePath}-wait-`;
const usePrefix = `${leasePath}-use-`;

// One shared Jira site: the identity space with its lease and reservation properties, and a
// manual clock. `property` is the lease; `reservation` is the priority waiter's; `waiters` maps
// each waiter's entry key to its value, and `sharing` each sharing holder's. `s.lease` makes a lease on it; `s.factory` is the same
// for code that takes a siteLease-shaped factory.
export function leaseSite({ description = markers.identityProject } = {}) {
  const s = {
    clock: 0,
    property: undefined,
    reservation: undefined,
    waiters: new Map(),
    sharing: new Map(),
    writes: 0,
    deletes: 0,
  };
  const key = (url) => (url === leasePath ? 'property' : url === next ? 'reservation' : undefined);
  s.api = async (url, method = 'GET', data) => {
    if (url === '/project/AUTH') return { key: 'AUTH', description };
    if (url === '/project/AUTH/properties') {
      assert.equal(method, 'GET');
      const names = [
        'acme.site-lease',
        'other.unrelated',
        ...s.waiters.keys(),
        ...s.sharing.keys(),
      ];
      return { keys: names.map((name) => ({ key: name })) };
    }
    for (const [prefix, map] of [
      [waitPrefix, s.waiters],
      [usePrefix, s.sharing],
    ])
      if (url.startsWith(prefix)) {
        const name = url.slice('/project/AUTH/properties/'.length);
        if (method === 'PUT') map.set(name, structuredClone(data));
        else if (method === 'DELETE') map.delete(name);
        else return map.has(name) ? { value: structuredClone(map.get(name)) } : null;
        return null;
      }
    const name = key(url);
    assert.ok(name, url);
    if (method === 'PUT') {
      if (name === 'property') s.writes++;
      s[name] = structuredClone(data);
      return null;
    }
    if (method === 'DELETE') {
      if (name === 'property') s.deletes++;
      s[name] = undefined;
      return null;
    }
    return s[name] === undefined ? null : { value: structuredClone(s[name]) };
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
  s.factory = (api, options) => s.lease(options.holder, options);
  return s;
}
