import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFixturePermissions } from '../src/jira/fixture-permissions.mjs';
const names = ['BROWSE_PROJECTS', 'CREATE_ISSUES', 'DELETE_ISSUES'];
test('disposable fixture preflight requires cleanup rights as well as creation', async () => {
  for (const denied of names) {
    let calls = 0;
    await assert.rejects(
      checkFixturePermissions(async (path) => {
        calls++;
        assert.equal(path, '/mypermissions?projectId=1&permissions=' + names.join(','));
        return {
          permissions: Object.fromEntries(
            names.map((name) => [name, { havePermission: name !== denied }]),
          ),
        };
      }, '1'),
      new RegExp(denied),
    );
    assert.equal(calls, 1);
  }
});
test('fixture preflight fails closed on malformed permissions or IDs', async () => {
  await assert.rejects(
    checkFixturePermissions(async () => {
      throw Error('should not be called');
    }, '1&injected'),
  );
  for (const response of [null, {}, { permissions: { DELETE_ISSUES: { havePermission: 'true' } } }])
    await assert.rejects(checkFixturePermissions(async () => response, '1'));
  let path;
  await checkFixturePermissions(async (p) => {
    path = p;
    return {
      permissions: Object.fromEntries(names.map((name) => [name, { havePermission: true }])),
    };
  }, '1');
  assert.equal(
    path,
    '/mypermissions?projectId=1&permissions=BROWSE_PROJECTS,CREATE_ISSUES,DELETE_ISSUES',
  );
});
