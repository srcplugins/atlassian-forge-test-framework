import test from 'node:test';
import assert from 'node:assert/strict';

import { primary } from './support/config.mjs';
import { sitePreflight } from '../src/jira/site-preflight.mjs';

const credentials = {
  site: primary,
  email: 'synthetic@example.invalid',
  token: 'synthetic-secret',
};
test('site audit stays GET-only, prevents credential redirects and omits identity/content', async () => {
  const bodies = [
    { baseUrl: `https://${credentials.site}`, deploymentType: 'Cloud' },
    { accountId: 'private-identity', active: true, emailAddress: 'private-email' },
    { permissions: { ADMINISTER: { havePermission: true } } },
    [
      {
        key: 'jira-software',
        userCount: 1,
        numberOfSeats: 100000,
        remainingSeats: 99999,
        groups: ['private-group'],
      },
    ],
    {
      total: 1,
      values: [{ id: '10000', key: 'KAN', style: 'next-gen', name: 'private-project-name' }],
    },
  ];
  let calls = 0;
  const result = await sitePreflight({
    ...credentials,
    fetchImpl: async (url, options) => {
      assert.ok(url.startsWith(`https://${credentials.site}/rest/api/3/`));
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.body, undefined);
      const body = bodies[calls++];
      return { status: 200, ok: true, json: async () => body };
    },
  });
  assert.equal(calls, 5);
  assert.equal(result.results.permissions.CREATE_SHARED_OBJECTS, null);
  assert.equal(result.results.applicationRoles.roles[0].reportedSeats, 100000);
  assert.doesNotMatch(JSON.stringify(result), /private-|synthetic-secret|Authorization/);
});
test('site audit fails closed for unknown sites, transport failure and canonical mismatch', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    throw Error('Authorization: secret');
  };
  await assert.rejects(
    sitePreflight({ ...credentials, site: 'unowned.atlassian.net', fetchImpl }),
    /owned/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    sitePreflight({ ...credentials, fetchImpl }),
    (error) => !error.message.includes('secret') && /suppressed/.test(error.message),
  );
  calls = 0;
  await assert.rejects(
    sitePreflight({
      ...credentials,
      fetchImpl: async () => {
        calls++;
        return {
          status: 200,
          ok: true,
          json: async () => ({ baseUrl: 'https://example.atlassian.net', deploymentType: 'Cloud' }),
        };
      },
    }),
    /Canonical/,
  );
  assert.equal(calls, 1);
});
