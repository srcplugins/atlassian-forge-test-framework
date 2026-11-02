import assert from 'node:assert/strict';
import { markers } from '../../src/core/markers.mjs';
import { siteLease } from '../../src/jira/site-lease.mjs';

const leasePath = '/project/AUTH/properties/acme.site-lease';
const next = `${leasePath}-next`;

// One shared Jira site: the identity space with its lease and reservation properties, and a
// manual clock. `property` is the lease; `reservation` is the priority waiter's. `s.lease` makes
// a lease on it; `s.factory` is the same for code that takes a siteLease-shaped factory.
export function leaseSite({ description = markers.identityProject } = {}) {
  const s = { clock: 0, property: undefined, reservation: undefined, writes: 0, deletes: 0 };
  const key = (url) => (url === leasePath ? 'property' : url === next ? 'reservation' : undefined);
  s.api = async (url, method = 'GET', data) => {
    if (url === '/project/AUTH') return { key: 'AUTH', description };
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
