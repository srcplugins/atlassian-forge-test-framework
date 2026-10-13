import test from 'node:test';
import assert from 'node:assert/strict';

import { observeAction } from '../src/jira/observe.mjs';

test('resolver observer consumes a save response before the click finishes navigating', async () => {
  let predicate,
    resolveResponse,
    navigated = false;
  const target = { appId: 'app', environmentId: 'development' };
  const response = {
    request: () => ({
      postDataJSON: () => ({
        variables: {
          input: {
            payload: { call: { functionKey: 'save' }, context: { environmentId: 'development' } },
            extensionId: 'app-field',
          },
        },
      }),
    }),
    json: async () => {
      assert.equal(navigated, false, 'Response body is unavailable after navigation');
      return { ok: true, value: { ids: [] } };
    },
  };
  const page = {
    waitForResponse(fn) {
      predicate = fn;
      return new Promise((resolve) => {
        resolveResponse = resolve;
      });
    },
  };
  const result = await observeAction(
    page,
    'save',
    async () => {
      assert.equal(await predicate(response), true);
      resolveResponse(response);
      navigated = true;
    },
    target,
  );
  assert.deepEqual(result, { ids: [] });
});
