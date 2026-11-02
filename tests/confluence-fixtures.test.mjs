import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configure } from '../src/core/config.mjs';
import { markers } from '../src/core/markers.mjs';
import { FixtureRun } from '../src/core/run-journal.mjs';
import {
  changeLabel,
  confluenceCall,
  confluenceTarget,
  journalFile,
  pageAdapter,
  prepareSpace,
  restrictPage,
} from '../src/confluence/index.mjs';

const host = 'confluence-example.atlassian.net';
const runId = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';

function setup(t) {
  const state = mkdtempSync(join(tmpdir(), 'confluence-fixtures-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  configure({
    namespace: 'synthetic',
    state,
    sites: [{ role: 'primary', host, products: ['confluence'] }],
    fixtures: { confluenceSpaces: { example: 'SYNTH' } },
  });
}

/**
 * An in-memory Confluence holding spaces, pages, labels and read restrictions. `fail` names
 * requests ("METHOD path-prefix") whose response is lost after the change is applied.
 */
function site({ fail = [], refuse = {} } = {}) {
  const spaces = [];
  const pages = new Map();
  const calls = [];
  let next = 100;
  const json = (status, body) => ({ status: () => status, text: async () => JSON.stringify(body) });
  const request = {
    async fetch(url, { method, data, headers }) {
      const { pathname, searchParams } = new URL(url);
      const route = `${method} ${pathname}`;
      calls.push({ route, search: searchParams.toString(), data, origin: headers.Origin });
      if (refuse[route]) return json(refuse[route], {});
      let response;
      const page = pages.get(pathname.match(/\/(?:pages|content)\/(\d+)/)?.[1]);
      if (route === 'GET /wiki/api/v2/spaces')
        response = json(200, {
          results: spaces.filter((s) => searchParams.get('keys') === s.key),
        });
      else if (route === 'POST /wiki/rest/api/space') {
        spaces.push({
          id: '7',
          key: data.key,
          description: { plain: { value: data.description.plain.value } },
        });
        response = json(200, {});
      } else if (route === 'POST /wiki/api/v2/pages') {
        const id = String(next++);
        pages.set(id, { id, ...data, labels: [], read: [] });
        response = json(200, { id });
      } else if (/^GET \/wiki\/api\/v2\/spaces\/\d+\/pages$/.test(route))
        response = json(200, {
          results: [...pages.values()].filter((p) => p.title === searchParams.get('title')),
        });
      else if (/^GET \/wiki\/api\/v2\/pages\/\d+$/.test(route))
        response = page ? json(200, page) : json(404, {});
      else if (/^DELETE \/wiki\/api\/v2\/pages\/\d+$/.test(route)) {
        if (!page) response = json(404, {});
        else if (searchParams.get('purge') === 'true') {
          pages.delete(page.id);
          response = json(204, null);
        } else {
          page.status = 'trashed';
          response = json(204, null);
        }
      } else if (/labels$/.test(pathname) && method === 'GET')
        response = json(200, { results: page.labels.map((name) => ({ prefix: 'global', name })) });
      else if (/label$/.test(pathname) && method === 'POST') {
        page.labels.push(data[0].name);
        response = json(200, {});
      } else if (/label$/.test(pathname) && method === 'DELETE') {
        page.labels = page.labels.filter((n) => n !== searchParams.get('name'));
        response = json(204, null);
      } else if (/restriction$/.test(pathname)) {
        page.read = data.results[0].restrictions.user.results.map((u) => u.accountId);
        response = json(200, {});
      } else if (/restriction\/byOperation\/read$/.test(pathname))
        response = json(200, {
          restrictions: { user: { results: page.read.map((accountId) => ({ accountId })) } },
        });
      else throw Error(`Unexpected request ${route}`);
      if (fail.some((f) => route.startsWith(f))) throw Error('socket hang up');
      return response;
    },
  };
  return { request, spaces, pages, calls, call: confluenceCall(request, host) };
}

test('requests stay on the verified site with its Origin, and refuse other paths and methods', async (t) => {
  setup(t);
  const fake = site();
  await fake.call('/wiki/api/v2/spaces?keys=SYNTH');
  assert.equal(fake.calls[0].origin, `https://${host}`);
  for (const [route, method] of [
    ['/rest/api/3/project', 'GET'],
    ['/wiki/api/v2/../x', 'GET'],
    ['/wiki/api/v2/pages/1.json', 'GET'],
    ['//evil.example/wiki/api/v2/pages', 'GET'],
    ['/wiki/api/v2/pages', 'PATCH'],
  ])
    await assert.rejects(fake.call(route, method), /Invalid Confluence/);
  assert.equal(fake.calls.length, 1);
});

test('the fixture space is created once, journaled first, and its marker verified', async (t) => {
  setup(t);
  const fake = site();
  const space = await prepareSpace(fake.call, 'example');
  assert.deepEqual(space, { id: '7', key: 'SYNTH' });
  assert.equal(fake.spaces[0].description.plain.value, markers.browserProject('example'));
  const journal = join(confluenceTarget().runs, '..', 'space-SYNTH.json');
  assert.equal(JSON.parse(readFileSync(journal, 'utf8')).status, 'verified');
  await prepareSpace(fake.call, 'example');
  assert.equal(fake.calls.filter((c) => c.route.startsWith('POST')).length, 1);
  fake.spaces[0].description.plain.value = 'Someone else';
  await assert.rejects(prepareSpace(fake.call, 'example'), /ownership mismatch/);
});

test('an unresolved space creation stops until it is inspected', async (t) => {
  setup(t);
  const fake = site({ fail: ['POST /wiki/rest/api/space'] });
  await assert.rejects(prepareSpace(fake.call, 'example'), /transport failed/);
  fake.spaces.length = 0;
  const again = site();
  await assert.rejects(prepareSpace(again.call, 'example'), /Unresolved space creation/);
  assert.equal(again.calls.filter((c) => c.route.startsWith('POST')).length, 0);
});

test('pages are journaled, rechecked and purged; a lost create is found by its marker, never repeated', async (t) => {
  setup(t);
  const fake = site({ fail: ['POST /wiki/api/v2/pages'] });
  const space = await prepareSpace(fake.call, 'example');
  const journal = journalFile(runId);
  const run = FixtureRun.create({
    app: 'example',
    site: host,
    projectId: space.id,
    runId,
    save: journal.save,
    adapters: { page: pageAdapter(fake.call, space, runId) },
  });
  const marker = markers.runMarker(runId, 0);
  await assert.rejects(run.create('page', { marker, title: `${marker} Synthetic page` }));
  assert.equal(fake.pages.size, 1);
  assert.equal(journal.load().resources[0].status, 'creating');
  await run.cleanup();
  assert.equal(fake.pages.size, 0);
  assert.equal(journal.load().status, 'clean');
  assert.equal(journal.load().resources[0].reconciled, true);
  assert.equal(fake.calls.filter((c) => c.route === 'POST /wiki/api/v2/pages').length, 1);
  assert.deepEqual(
    fake.calls.filter((c) => c.route.startsWith('DELETE')).map((c) => c.search),
    ['', 'purge=true'],
  );
});

test('cleanup refuses a page whose title or space no longer matches', async (t) => {
  setup(t);
  const fake = site();
  const space = await prepareSpace(fake.call, 'example');
  const run = FixtureRun.create({
    app: 'example',
    site: host,
    projectId: space.id,
    runId,
    save: journalFile(runId).save,
    adapters: { page: pageAdapter(fake.call, space, runId) },
  });
  const marker = markers.runMarker(runId, 0);
  const entry = await run.create('page', { marker, title: `${marker} Synthetic page` });
  fake.pages.get(entry.id).title = 'Renamed by someone';
  await assert.rejects(run.cleanup(), /cleanup incomplete/);
  assert.equal(fake.pages.size, 1);
  await assert.rejects(run.create('page', { marker: 'other', title: 'Unmarked' }), /Unmarked/);
});

test('label changes report applied or rejected, and an uncertain one is read back', async (t) => {
  setup(t);
  const fake = site({ fail: ['DELETE /wiki/rest/api/content'] });
  fake.pages.set('5', { id: '5', labels: [], read: [] });
  assert.deepEqual(await changeLabel(fake.call, '5', 'add', 'alpha'), {
    outcome: 'applied',
    status: 200,
  });
  assert.deepEqual(await changeLabel(fake.call, '5', 'remove', 'alpha'), {
    outcome: 'applied',
    status: null,
    reconciled: true,
  });
  const refused = site({ refuse: { 'POST /wiki/rest/api/content/5/label': 403 } });
  refused.pages.set('5', { id: '5', labels: [], read: [] });
  assert.deepEqual(await changeLabel(refused.call, '5', 'add', 'alpha'), {
    outcome: 'rejected',
    status: 403,
  });
  for (const [id, name] of [
    ['x', 'alpha'],
    ['5', 'Alpha'],
    ['5', 'a b'],
  ])
    await assert.rejects(changeLabel(fake.call, id, 'add', name), /lowercase label/);
});

test('restrictions replace the user lists and an uncertain write is read back', async (t) => {
  setup(t);
  const fake = site({ fail: ['PUT /wiki/rest/api/content'] });
  fake.pages.set('5', { id: '5', labels: [], read: [] });
  const result = await restrictPage(fake.call, '5', { read: ['owner-1', 'member-1'] });
  assert.deepEqual(result, { outcome: 'applied', status: null, reconciled: true });
  await assert.rejects(restrictPage(fake.call, '5', { read: [] }), /account IDs/);
});

test('run journals are private files named by run ID', (t) => {
  setup(t);
  assert.throws(() => journalFile('../x'), /Invalid run ID/);
  const journal = journalFile(runId);
  journal.save({ status: 'active' });
  assert.ok(existsSync(journal.file));
  writeFileSync(journal.file, '{"status":"clean"}');
  assert.equal(journal.load().status, 'clean');
});
