import test from 'node:test';
import assert from 'node:assert/strict';

import { retryRead, safeRequest } from '../src/core/safe-request.mjs';
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
      'TypeError, UND_ERR_SOCKET, fetch failed',
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

test('only a dropped or stalled connection is marked transient', async () => {
  const marked = async (error) => {
    try {
      await safeRequest(() => Promise.reject(error), 'GET fetch');
    } catch (failure) {
      return failure.transient;
    }
    assert.fail('the request resolved');
  };
  for (const error of [
    Object.assign(Error(secret), { code: 'ECONNRESET' }),
    Error(`connect ETIMEDOUT 10.0.0.1:443 ${secret}`),
    Error(`socket hang up ${secret}`),
    Error(`apiRequestContext.fetch: Timeout 30000ms exceeded. ${secret}`),
    TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } }),
    TypeError('fetch failed'),
    Object.assign(Error(secret), { name: 'TimeoutError' }),
  ])
    assert.equal(await marked(error), true, error.message);
  for (const error of [
    Object.assign(Error(secret), { code: 'ECONNREFUSED' }),
    TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }),
    Error(`Request context disposed. ${secret}`),
    SyntaxError(secret),
    Error(secret),
    secret,
  ])
    assert.equal(await marked(error), false, String(error?.message ?? error));
});

// A client whose fetch answers from a queue: an Error is thrown, a number is an HTTP status.
function queued(answers) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push(options.method);
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    const status = answer ?? 200;
    return { status: () => status, ok: () => status < 300, text: async () => '{"ok":true}' };
  };
  const logs = [];
  const pauses = [];
  const retry = { log: (line) => logs.push(line), sleep: async (ms) => pauses.push(ms) };
  return { api: client({ fetch }, `https://${primary}`, { retry }), calls, logs, pauses };
}
const reset = () => Object.assign(Error(`read ECONNRESET ${secret}`), { code: 'ECONNRESET' });

test('a GET that fails on transport or with 502, 503 or 504 runs once more, and says so', async () => {
  for (const [first, reason] of [
    [reset(), 'a transport failure (GET fetch: ECONNRESET)'],
    [
      Error(`apiRequestContext.fetch: Timeout 30000ms exceeded. ${secret}`),
      'a transport failure (GET fetch: timeout)',
    ],
    [502, 'HTTP 502'],
    [503, 'HTTP 503'],
    [504, 'HTTP 504'],
  ]) {
    const q = queued([first, 200]);
    assert.deepEqual(await q.api('/issue/DEMO-1'), { ok: true });
    assert.deepEqual(q.calls, ['GET', 'GET']);
    assert.deepEqual(q.logs, [`Retrying a Jira GET once after ${reason}.`]);
    assert.deepEqual(q.pauses, [2000]);
    assert.doesNotMatch(q.logs[0], /DEMO|Basic|cookie|issue/);
  }
});

test('a read retries only once, and never on a lasting failure', async () => {
  const twice = queued([reset(), reset()]);
  await assert.rejects(twice.api('/myself'), /\(GET fetch: ECONNRESET\)/);
  assert.equal(twice.calls.length, 2);
  for (const first of [500, 429, 401, Object.assign(Error(secret), { code: 'ENOTFOUND' })]) {
    const q = queued([first, 200]);
    await assert.rejects(q.api('/myself'));
    assert.equal(q.calls.length, 1, String(first));
    assert.deepEqual(q.logs, []);
  }
});

test('a write is never retried, whatever its failure', async () => {
  for (const method of ['POST', 'PUT', 'DELETE'])
    for (const first of [reset(), 502, 503, 504]) {
      const q = queued([first, 200]);
      await assert.rejects(q.api('/issue/1', method, {}));
      assert.deepEqual(q.calls, [method]);
      assert.deepEqual(q.logs, []);
    }
});

test('retryRead also retries an answer whose status is a gateway error', async () => {
  const answers = [{ status: 503 }, { status: 200 }];
  const logs = [];
  const result = await retryRead(async () => answers.shift(), {
    label: 'probe',
    status: (r) => r.status,
    log: (line) => logs.push(line),
    sleep: async () => {},
  });
  assert.deepEqual(result, { status: 200 });
  assert.deepEqual(logs, ['Retrying a probe once after HTTP 503.']);
  // A second gateway answer is returned as it is, for the caller to refuse.
  const again = [{ status: 502 }, { status: 504 }];
  assert.deepEqual(
    await retryRead(async () => again.shift(), {
      status: (r) => r.status,
      log: () => {},
      sleep: async () => {},
    }),
    { status: 504 },
  );
});
