import test from 'node:test';
import assert from 'node:assert/strict';

import { safeRequest } from '../src/core/safe-request.mjs';
import { client } from '../src/jira/client.mjs';
import { primary } from './support/config.mjs';

const secret = 'Authorization: Basic c3ludGhldGljLXNlY3JldA== cookie=tenant.session.token';
const failure = async (call) => {
  try {
    await call();
  } catch (error) {
    assert.equal(error.cause, undefined);
    return error.message;
  }
  assert.fail('the request resolved');
};
const thrown = (error, stage) => failure(() => safeRequest(() => Promise.reject(error), stage));

test('a transport failure names its stage and kind, never its message', async () => {
  const cases = [
    [Object.assign(Error(`read ${secret}`), { code: 'ECONNRESET' }), 'ECONNRESET'],
    [Error(`apiRequestContext.fetch: ${secret} connect ETIMEDOUT 10.0.0.1:443`), 'ETIMEDOUT'],
    [Error(`apiRequestContext.fetch: socket hang up ${secret}`), 'socket hang up'],
    [Error(`apiRequestContext.fetch: Timeout 30000ms exceeded. ${secret}`), 'timeout'],
    [Error(`Request context disposed. ${secret}`), 'closed'],
    [
      TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET', message: secret } }),
      'TypeError, UND_ERR_SOCKET',
    ],
    [Object.assign(Error(secret), { name: 'AbortError' }), 'AbortError'],
  ];
  for (const [error, kind] of cases) {
    const message = await thrown(error, 'POST fetch');
    assert.equal(
      message,
      `Verification transport failed (POST fetch: ${kind}). Request diagnostics suppressed to protect credentials.`,
    );
  }
  for (const error of [Error(secret), { message: secret, code: secret, name: secret }, secret]) {
    const message = await thrown(error);
    assert.equal(
      message,
      'Verification transport failed (request). Request diagnostics suppressed to protect credentials.',
    );
  }
});

test('the Jira client reports which stage failed, with the status once it has one', async () => {
  const response = (text) => ({ status: () => 200, ok: () => true, text });
  const api = (fetch) => client({ fetch }, `https://${primary}`);
  assert.match(
    await failure(() =>
      api(() => Promise.reject(Error(`ECONNRESET ${secret}`)))('/myself', 'POST'),
    ),
    /\(POST fetch: ECONNRESET\)/,
  );
  assert.match(
    await failure(() =>
      api(async () => response(() => Promise.reject(Error(`closed ${secret}`))))('/myself'),
    ),
    /\(GET HTTP 200 body read\)/,
  );
  const message = await failure(() =>
    api(async () => response(async () => `<html>${secret}</html>`))('/myself'),
  );
  assert.match(message, /\(GET HTTP 200 JSON parse: SyntaxError\)/);
  assert.doesNotMatch(message, /html|Basic|cookie|token/);
});
