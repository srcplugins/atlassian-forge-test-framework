import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateIdentityFixture, verifyIdentityPermissions } from '../src/jira/identity.mjs';
import { primary, second } from './support/config.mjs';
const fixture = {
  site: `https://${primary}`,
  project: { key: 'AUTH', id: '100' },
  scheme: { id: '200' },
  actors: { owner: 'owner', member: 'member', restricted: 'restricted' },
};
test('identity fixture rejects foreign target, unmarked space and colliding/missing identities', () => {
  assert.equal(validateIdentityFixture(fixture, primary).project.id, '100');
  assert.throws(() => validateIdentityFixture(fixture, second));
  for (const change of [
    { site: `https://${second}` },
    { project: { key: 'PLAT', id: '100' } },
    { actors: { owner: 'owner', member: 'owner', restricted: 'restricted' } },
    { actors: {} },
    { scheme: {} },
  ])
    assert.throws(() => validateIdentityFixture({ ...fixture, ...change }, primary));
});
test('identity preflight refuses changed grants and unknown permission values', () => {
  const perms = Object.fromEntries(
    Object.entries({
      BROWSE_PROJECTS: true,
      EDIT_ISSUES: true,
      ADD_COMMENTS: false,
      ADMINISTER_PROJECTS: false,
      ADMINISTER: false,
    }).map(([k, v]) => [k, { havePermission: v }]),
  );
  verifyIdentityPermissions(perms, 'restricted');
  assert.throws(() => verifyIdentityPermissions(perms, 'member'), /ADD_COMMENTS/);
  assert.throws(
    () =>
      verifyIdentityPermissions({ ...perms, ADMINISTER: { havePermission: true } }, 'restricted'),
    /ADMINISTER/,
  );
  assert.throws(
    () =>
      verifyIdentityPermissions(
        { ...perms, BROWSE_PROJECTS: { havePermission: 'true' } },
        'restricted',
      ),
    /BROWSE/,
  );
});
