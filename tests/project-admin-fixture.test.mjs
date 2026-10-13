import { test } from 'node:test';
import assert from 'node:assert/strict';

import './support/config.mjs';
import { projectAdminFixture } from '../src/jira/permission-grants.mjs';
import { legacyMarker, markers } from '../src/core/markers.mjs';
function fixture({ shared = false, scheme = markers.identityProject } = {}) {
  const identity = {
    project: { id: '100' },
    scheme: { id: '200' },
    actors: { member: 'member', restricted: 'restricted' },
  };
  const state = {
    permissions: [
      { id: 1, permission: 'BROWSE_PROJECTS', holder: { type: 'user', parameter: 'member' } },
    ],
    writes: [],
  };
  const api = async (path, method = 'GET', data) => {
    if (method !== 'GET') state.writes.push({ path, method, data });
    if (path.startsWith('/project/search?'))
      return { values: [{ id: '100' }, { id: '101' }], isLast: true };
    if (path === '/project/100/permissionscheme') return { id: 200 };
    if (path === '/project/101/permissionscheme') return { id: shared ? 200 : 201 };
    if (path === '/permissionscheme/200') return { description: scheme };
    if (path === '/permissionscheme/200/permission') {
      if (method === 'POST') {
        const grant = { id: 2, ...data };
        state.permissions.push(grant);
        return grant;
      }
      return { permissions: structuredClone(state.permissions) };
    }
    if (path === '/permissionscheme/200/permission/2') {
      if (method === 'DELETE') {
        state.permissions = state.permissions.filter((p) => p.id !== 2);
        return null;
      }
      return state.permissions.find((p) => p.id === 2) ?? null;
    }
    throw Error('Unexpected test API call');
  };
  return {
    state,
    ...projectAdminFixture(api, identity, async () => {}),
  };
}
test('temporary admin fixture refuses a shared scheme before any grant', async () => {
  const f = fixture({ shared: true });
  const expected = await f.intent();
  await assert.rejects(f.adapter.create(expected), /shared/);
  assert.deepEqual(f.state.writes, []);
});
test('temporary admin fixture removes only exact pinned grant and restores baseline', async () => {
  const f = fixture(),
    expected = await f.intent();
  const grant = await f.adapter.create(expected),
    entry = { id: String(grant.id), expected };
  await f.adapter.verify(entry);
  await f.adapter.remove(entry);
  assert.equal(await f.adapter.read(entry.id), null);
  assert.deepEqual(
    f.state.writes.map((x) => x.method),
    ['POST', 'DELETE'],
  );
  assert.deepEqual((await f.intent()).before, expected.before);
});
test('temporary admin cleanup stops on changed holder or unrelated permission drift', async () => {
  for (const drift of ['holder', 'unrelated']) {
    const f = fixture(),
      expected = await f.intent();
    const grant = await f.adapter.create(expected),
      entry = { id: String(grant.id), expected };
    if (drift === 'holder') grant.holder = { type: 'user', parameter: 'foreign' };
    else
      f.state.permissions.push({
        id: 3,
        permission: 'EDIT_ISSUES',
        holder: { type: 'user', parameter: 'foreign' },
      });
    await assert.rejects(f.adapter.remove(entry));
    assert.equal(f.state.writes.filter((x) => x.method === 'DELETE').length, 0);
  }
});

test('identity scheme marker may be pre-rename; an unrelated scheme is refused before writes', async () => {
  const legacy = fixture({ scheme: legacyMarker(markers.identityProject) });
  const expected = await legacy.intent();
  const grant = await legacy.adapter.create(expected);
  const entry = { id: String(grant.id), expected };
  await legacy.adapter.verify(entry);
  await legacy.adapter.remove(entry);
  assert.equal(await legacy.adapter.read(entry.id), null);
  const unrelated = fixture({ scheme: 'Shared customer scheme' });
  await assert.rejects(async () => unrelated.adapter.create(await unrelated.intent()));
  assert.deepEqual(unrelated.state.writes, []);
});
