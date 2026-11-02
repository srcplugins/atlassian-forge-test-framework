import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { configure, validateConfig } from '../src/core/config.mjs';
import {
  client,
  confluenceTarget,
  spacePath,
  pagePath,
  spaceSettingsPath,
  pageGuard,
} from '../src/confluence/index.mjs';

const host = 'confluence-example.atlassian.net';
const base = { namespace: 'synthetic', sites: [{ role: 'primary', host }] };
const uuid = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';
const enable = () =>
  configure({ ...base, sites: [{ ...base.sites[0], products: ['confluence'] }] });

test('Confluence requires independently recorded product access and isolates private state', () => {
  configure(base);
  assert.throws(() => confluenceTarget(), /Verified owned Confluence/);
  for (const products of [[], ['jira', 'jira'], ['unknown'], 'confluence'])
    assert.throws(
      () => validateConfig({ ...base, sites: [{ ...base.sites[0], products }] }),
      /products/,
    );
  enable();
  assert.match(
    confluenceTarget().runs,
    /products\/confluence\/sites\/confluence-example.atlassian.net\/e2e\/runs$/,
  );
  assert.throws(() => confluenceTarget('other-example.atlassian.net'), /Verified owned/);
});

test('navigation uses Confluence paths and refuses invalid identities and injected routes', () => {
  assert.equal(spacePath('~personal'), '/wiki/spaces/~personal');
  assert.equal(pagePath('TEST', '42'), '/wiki/spaces/TEST/pages/42');
  assert.equal(
    spaceSettingsPath('TEST', uuid, uuid, 'label-history'),
    `/wiki/spaces/TEST/settings/apps/${uuid}/${uuid}/label-history`,
  );
  for (const key of ['', '../TEST', 'TEST?x', 'TEST\\x']) assert.throws(() => spacePath(key));
  for (const id of ['0', '-1', '../42', 42]) assert.throws(() => pagePath('TEST', id));
  assert.throws(() => spaceSettingsPath('TEST', uuid, uuid, '../other'));
  assert.throws(() => spaceSettingsPath('TEST', 'app', uuid, 'valid'));
});

test('read client uses an owned Confluence route, suppresses redirects and makes one GET', async () => {
  enable();
  const calls = [];
  const api = client({
    fetch: async (...args) => {
      calls.push(args);
      return { ok: () => true, json: async () => ({ id: '42' }) };
    },
  });
  assert.deepEqual(await api('/wiki/api/v2/pages/42'), { id: '42' });
  assert.deepEqual(calls, [
    [`https://${host}/wiki/api/v2/pages/42`, { method: 'GET', timeout: 30000, maxRedirects: 0 }],
  ]);
  for (const path of [
    '/rest/api/3/project/42',
    '//evil.example/wiki/api/v2/pages',
    '/wiki/api/v2/../other',
    '/wiki/api/v2/%2e%2e/other',
    '/wiki/api/v2/pages/42#x',
    '/wiki/api/v2/pages/42?x=\\evil',
    null,
  ])
    await assert.rejects(api(path), /Invalid Confluence/);
  assert.equal(calls.length, 1);
});

test('denied, throttled and failed reads never establish visibility; only a gateway error retries', async () => {
  enable();
  for (const [status, attempts] of [
    [301, 1],
    [401, 1],
    [403, 1],
    [404, 1],
    [429, 1],
    [500, 1],
    [503, 2],
  ]) {
    let calls = 0;
    const api = client(
      {
        fetch: async () => {
          calls++;
          return { ok: () => false, status: () => status };
        },
      },
      undefined,
      { retry: { log: () => {}, sleep: async () => {} } },
    );
    await assert.rejects(api('/wiki/rest/api/content/42'), /visibility is not established/);
    assert.equal(calls, attempts, `HTTP ${status}`);
  }
  const transport = client({
    fetch: async () => {
      throw Error('SECRET cookie');
    },
  });
  await assert.rejects(transport('/wiki/api/v2/pages/42'), (e) => !/SECRET|cookie/.test(e.message));
  const json = client({
    fetch: async () => ({
      ok: () => true,
      json: async () => {
        throw Error('SECRET body');
      },
    }),
  });
  await assert.rejects(json('/wiki/api/v2/pages/42'), (e) => !/SECRET/.test(e.message));
});

test('Confluence guard detects headingless error alerts and stuck Forge frames', async () => {
  let binding, name, script;
  const guard = await pageGuard(
    {
      exposeBinding: async (bindingName, fn) => {
        name = bindingName;
        binding = fn;
      },
      addInitScript: async (source) => {
        script = source;
      },
    },
    { appIds: [uuid], appLoadLimit: 1000 },
  );
  const alerts = [];
  let tick,
    now = 0;
  let load;
  const win = { addEventListener: (_type, fn) => (load = fn) };
  win.top = win;
  win[name] = async (event) => binding({}, event);
  const frame = {
    tagName: 'IFRAME',
    isConnected: true,
    src: `https://cdn.example/${uuid}/index.html`,
    title: 'Synthetic app',
    closest: () => null,
    getClientRects: () => [1],
  };
  frame.parentElement = { children: [], querySelector: () => ({}) };
  runInNewContext(script, {
    window: win,
    document: { querySelectorAll: (s) => (s === '[role="alert"]' ? alerts : [frame]) },
    performance: { now: () => now },
    getComputedStyle: () => ({ visibility: 'hidden' }),
    setInterval: (fn) => {
      tick = fn;
    },
  });
  load({ target: frame });
  alerts.push({ innerText: 'Something went wrong', querySelector: () => null });
  tick();
  await new Promise(setImmediate);
  assert.throws(() => guard.check(), /Confluence showed/);
  guard.allowFlag('Something went wrong');
  now = 2000;
  tick();
  await new Promise(setImmediate);
  assert.throws(() => guard.check(), /Confluence.s loading placeholder/);
});
