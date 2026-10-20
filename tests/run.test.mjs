import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { second } from './support/config.mjs';
import { openRun, registerProfile } from '../src/jira/run.mjs';
import { client } from '../src/jira/client.mjs';
import { legacyMarker, markers } from '../src/core/markers.mjs';
const typedApp = 'demo-app';
// An owned fixture space plus work items with fields, labels and properties, over fetch.
function transport({ app = 'forge-sandbox', key = 'SBOX', description } = {}) {
  const data = {
    project: {
      id: '777',
      key,
      style: 'classic',
      projectTypeKey: 'software',
      description: description ?? markers.browserProject(app),
      issueTypes: [
        { id: '1', name: 'Task', subtask: false },
        { id: '39', name: 'Prompt', subtask: false },
      ],
    },
    issues: new Map(),
    issue: null, // The most recently created work item.
    posts: [],
    denied: null,
    comments: [], // Comments on every fixture work item.
    changelogs: new Map(), // Work item ID to its history entries.
    propertyLag: 0, // Work item reads that still come back without the create's properties.
  };
  let deletes = 0;
  let nextId = 888;
  const request = {
    fetch: async (url, options) => {
      const { pathname: path, searchParams } = new URL(url);
      const id = path.match(/\/issue\/(\d+)/)?.[1];
      let body;
      if (path.endsWith('/myself')) body = { accountId: 'test-owner' };
      else if (path.endsWith('/mypermissions'))
        body = {
          permissions: Object.fromEntries(
            ['BROWSE_PROJECTS', 'CREATE_ISSUES', 'DELETE_ISSUES'].map((k) => [
              k,
              { havePermission: k !== data.denied },
            ]),
          ),
        };
      else if (path.includes('/project/')) body = data.project;
      else if (path.endsWith('/comment'))
        body = { comments: data.comments, total: data.comments.length };
      else if (path.endsWith('/changelog'))
        body = { values: data.changelogs.get(id) ?? [], isLast: true };
      else if (path.endsWith('/search/jql'))
        body = { issues: [...data.issues.values()], isLast: true };
      else if (path.includes('/properties/')) {
        const value = data.issues.get(id)?.properties[decodeURIComponent(path.split('/').at(-1))];
        body = value === undefined ? null : { value };
      } else if (options.method === 'POST') {
        data.posts.push(options.data);
        body = {
          id: String(nextId++),
          // Like Jira, the creating account becomes the reporter.
          fields: {
            ...options.data.fields,
            reporter: { accountId: 'test-owner' },
            status: { id: '10', name: 'Prompt available' },
            subtasks: [],
            attachment: [],
            issuelinks: [],
          },
          properties: Object.fromEntries(
            (options.data.properties ?? []).map(({ key, value }) => [key, value]),
          ),
        };
        data.issues.set(body.id, body);
        data.issue = body;
      } else if (options.method === 'DELETE') {
        deletes++;
        data.issues.delete(id);
        return { ok: () => true, status: () => 204 };
      } else {
        const issue = data.issues.get(id);
        const keys = (searchParams.get('properties') ?? '').split(',');
        const lagging = issue && keys[0] && data.propertyLag > 0 && data.propertyLag--;
        body = issue && {
          ...issue,
          properties: Object.fromEntries(
            keys
              .filter((k) => !lagging && k in issue.properties)
              .map((k) => [k, issue.properties[k]]),
          ),
        };
        body ??= null;
      }
      return {
        ok: () => body !== null,
        status: () => (body === null ? 404 : 200),
        text: async () => JSON.stringify(body),
      };
    },
  };
  return {
    data,
    request,
    get deletes() {
      return deletes;
    },
  };
}
test('space ownership and missing cleanup permission fail before run creation', async () => {
  const t = transport();
  t.data.project.description = 'unrelated';
  await assert.rejects(() => openRun(t.request, 'forge-sandbox'), /Owned/);
  await assert.rejects(() => openRun(t.request, 'unknown'), /Unsupported/);
  t.data.project.description = markers.browserProject('forge-sandbox');
  t.data.denied = 'DELETE_ISSUES';
  await assert.rejects(
    () => openRun(t.request, 'forge-sandbox'),
    /Fixture permission missing: DELETE_ISSUES/,
  );
});
// A create whose response is lost: Jira stored the work item, the caller saw an error.
const losingCreate = (t) => {
  const fetch = t.request.fetch;
  t.request.fetch = async (url, options) => {
    const response = await fetch(url, options);
    if (options?.method === 'POST' && new URL(url).pathname.endsWith('/issue'))
      throw Error('lost response');
    return response;
  };
};
test('cleanup removes a work item whose create response was lost, while it is untouched', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixture-'));
  const t = transport();
  try {
    const f = await openRun(t.request, 'forge-sandbox', { directory });
    losingCreate(t);
    await assert.rejects(() => f.issue('synthetic'), /Verification transport failed/);
    assert.equal(t.data.posts.length, 1, 'the create is never repeated');
    await f.cleanup();
    assert.equal(t.deletes, 1);
    assert.equal(f.run.state.status, 'clean');
    assert.equal(t.data.posts.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('recovery closes a create that never landed only after five minutes and with no trace', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixture-'));
  const t = transport();
  try {
    const f = await openRun(t.request, 'forge-sandbox', { directory });
    const fetch = t.request.fetch;
    t.request.fetch = async (url, options) => {
      if (options?.method === 'POST' && new URL(url).pathname.endsWith('/issue'))
        throw Error('connection reset');
      return fetch(url, options);
    };
    await assert.rejects(() => f.issue('synthetic'), /Verification transport failed/);
    t.request.fetch = fetch;
    // The run's own cleanup can't tell a slow search from a create that never landed.
    await assert.rejects(() => f.cleanup(), /incomplete/);
    const recover = async () => {
      writeFileSync(
        join(directory, '777.lock'),
        JSON.stringify({ runId: f.run.state.runId, pid: 2147483647 }),
      );
      const resumed = await openRun(t.request, 'forge-sandbox', {
        directory,
        recover: f.run.state.runId,
      });
      await resumed.cleanup().catch(() => {});
      return JSON.parse(readFileSync(join(directory, `${f.run.state.runId}.json`), 'utf8'));
    };
    assert.equal((await recover()).status, 'cleanup-required', 'recorded under five minutes ago');
    f.run.state.resources[0].intended = new Date(Date.now() - 6 * 60_000).toISOString();
    f.run.persist();
    // A work item with the create's summary is a trace, even without the marker.
    const summary = f.run.state.resources[0].expected.summary;
    t.data.issues.set('901', { id: '901', fields: { summary, labels: [] }, properties: {} });
    assert.equal((await recover()).status, 'cleanup-required', 'a trace remains');
    t.data.issues.delete('901');
    const closed = await recover();
    assert.equal(closed.status, 'clean');
    assert.equal(closed.resources[0].reconciled, 'absent');
    assert.equal(t.deletes, 0);
    assert.equal(t.data.posts.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('a marker property that lands just after the create is read back with a bounded re-read', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixture-'));
  const t = transport({ app: typedApp, key: 'DEMO' });
  try {
    const f = await openRun(t.request, typedApp, { directory });
    t.data.propertyLag = 2;
    const prompt = await f.propertyIssue('Prompt fixture', 'Synthetic instructions', '39');
    assert.equal(t.data.propertyLag, 0);
    assert.equal(t.data.posts.length, 1, 'the create is never repeated');
    assert.ok(prompt.observedFields && prompt.prepareMs >= 0);
    await f.cleanup();
    assert.equal(t.deletes, 1);
    assert.equal(f.run.state.status, 'clean');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('a created work item whose check at creation failed is cleaned up only while unchanged since the create', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixture-'));
  const t = transport({ app: typedApp, key: 'DEMO' });
  try {
    const f = await openRun(t.request, typedApp, { directory });
    t.data.propertyLag = Infinity;
    await assert.rejects(() => f.propertyIssue('Prompt fixture', 'Synthetic instructions', '39'));
    t.data.propertyLag = 0;
    const [entry] = f.run.state.resources;
    assert.equal(entry.status, 'created');
    assert.equal(entry.observedFields, undefined);
    t.data.changelogs.set(entry.id, [
      {
        author: { accountId: 'test-owner' },
        created: new Date().toISOString(),
        items: [{ field: 'priority' }],
      },
    ]);
    await assert.rejects(() => f.cleanup(), /incomplete/, 'changed since the create');
    assert.match(f.run.state.leftovers[0].reason, /baseline missing/);
    t.data.issue.fields.issuetype = { id: '1' };
    t.data.changelogs.delete(entry.id);
    await assert.rejects(() => f.cleanup(), /incomplete/, 'another work type');
    t.data.issue.fields.issuetype = { id: '39' };
    writeFileSync(
      join(directory, '777.lock'),
      JSON.stringify({ runId: f.run.state.runId, pid: 2147483647 }),
    );
    const resumed = await openRun(t.request, typedApp, { directory, recover: f.run.state.runId });
    await resumed.cleanup();
    assert.equal(resumed.run.state.status, 'clean');
    assert.equal(t.deletes, 1);
    assert.equal(t.data.posts.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('a lost-response work item that someone else reported, retyped or commented on is refused', async () => {
  const changes = {
    reporter: (issue) => (issue.fields.reporter = { accountId: 'someone-else' }),
    type: (issue) => (issue.fields.issuetype = { id: '39' }),
    comment: (_issue, data) =>
      data.comments.push({ id: '1', author: { accountId: 'someone-else' }, body: null }),
  };
  for (const [name, change] of Object.entries(changes)) {
    const directory = mkdtempSync(join(tmpdir(), 'fixture-'));
    const t = transport();
    try {
      const f = await openRun(t.request, 'forge-sandbox', { directory });
      losingCreate(t);
      await assert.rejects(() => f.issue('synthetic'), /Verification transport failed/);
      change(t.data.issue, t.data);
      await assert.rejects(() => f.cleanup(), /incomplete/, name);
      assert.equal(t.deletes, 0, name);
      assert.equal(f.run.state.status, 'cleanup-required', name);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
// Jira's Create form as the browser submits it: no labels, properties or Description.
const formCreate = (t, typeId) => (summary) => {
  const id = String(950 + t.data.issues.size);
  t.data.issues.set(id, {
    id,
    fields: {
      summary,
      labels: [],
      description: null,
      project: { id: t.data.project.id },
      issuetype: { id: typeId },
      reporter: { accountId: 'test-owner' },
      status: { id: '10', name: 'To Do' },
      subtasks: [],
      attachment: [],
      issuelinks: [],
    },
    properties: {},
  });
};
test('a work item created through the Create form is found by its summary marker and cleaned up', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixture-'));
  const t = transport();
  try {
    const f = await openRun(t.request, 'forge-sandbox', { directory });
    let submits = 0;
    let filled;
    const issue = await f.browserIssue('Form fixture', '1', {
      fill: (summary) => {
        filled = summary;
      },
      submit: () => {
        submits++;
        formCreate(t, '1')(filled);
      },
    });
    assert.equal(submits, 1);
    assert.equal(t.data.posts.length, 0, 'nothing is created through the API');
    assert.match(issue.expected.summary, /^Form fixture \S+$/);
    assert.ok(issue.expected.summary.endsWith(issue.expected.marker));
    assert.ok(issue.id && issue.observedFields);
    await f.cleanup();
    assert.equal(t.deletes, 1);
    assert.equal(f.run.state.status, 'clean');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('a Create form submit that fails after the work item landed is cleaned up, never repeated', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixture-'));
  const t = transport();
  try {
    const f = await openRun(t.request, 'forge-sandbox', { directory });
    let submits = 0;
    let filled;
    await assert.rejects(
      () =>
        f.browserIssue('Form fixture', '1', {
          fill: (summary) => {
            filled = summary;
          },
          submit: () => {
            submits++;
            formCreate(t, '1')(filled);
            throw Error('dialog closed unexpectedly');
          },
        }),
      /dialog closed unexpectedly/,
    );
    assert.equal(submits, 1);
    await f.cleanup();
    assert.equal(t.deletes, 1);
    assert.equal(f.run.state.status, 'clean');
    // A form that fails before its submit created nothing: the run cleans up at once.
    const g = await openRun(t.request, 'forge-sandbox', { directory });
    await assert.rejects(
      () =>
        g.browserIssue('Form fixture', '1', {
          fill: () => {
            throw Error('Summary field not found');
          },
          submit: () => assert.fail('never submitted'),
        }),
      /Summary field not found/,
    );
    assert.equal(g.run.state.resources[0].status, 'rejected');
    // A bad work type or missing steps fail before intent is recorded.
    const steps = { fill() {}, submit() {} };
    await assert.rejects(() => g.browserIssue('Form fixture', '7', steps), /unavailable/);
    await assert.rejects(() => g.browserIssue('Form fixture', 'Task', steps), /Read the work/);
    await assert.rejects(
      () => g.browserIssue('Form fixture', '1', { fill() {} }),
      /fill and submit/,
    );
    assert.equal(g.run.state.resources.length, 1);
    await g.cleanup();
    assert.equal(g.run.state.status, 'clean');
    assert.equal(t.deletes, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('forge-test cleanup recovers a Create form work item after a hard stop', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixture-'));
  const t = transport();
  try {
    const f = await openRun(t.request, 'forge-sandbox', { directory });
    let filled;
    // The process stops after the click landed, before the run could reconcile or clean up.
    await assert.rejects(
      () =>
        f.browserIssue('Form fixture', '1', {
          fill: (summary) => {
            filled = summary;
          },
          submit: async () => {
            formCreate(t, '1')(filled);
            await f.releaseForRecovery();
            throw Error('hard stop');
          },
        }),
      /hard stop/,
    );
    const resumed = await openRun(t.request, 'forge-sandbox', {
      directory,
      recover: f.run.state.runId,
    });
    await resumed.cleanup();
    assert.equal(resumed.run.state.status, 'clean');
    assert.equal(t.deletes, 1);
    assert.equal(t.data.posts.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('a space without a Task type fails before intent is recorded', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixture-'));
  const t = transport();
  t.data.project.issueTypes = [{ id: '39', name: 'Prompt', subtask: false }];
  try {
    const f = await openRun(t.request, 'forge-sandbox', { directory });
    await assert.rejects(() => f.issue('synthetic'), /no Task work type/);
    assert.equal(t.data.posts.length, 0);
    assert.equal(f.run.state.resources.length, 0);
    await f.cleanup();
    assert.equal(f.run.state.status, 'clean');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('lock contention, foreign journal site and wrong work item space/marker are rejected', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixture-'));
  const t = transport();
  try {
    const f = await openRun(t.request, 'forge-sandbox', { directory });
    await assert.rejects(() => openRun(t.request, 'forge-sandbox', { directory }), /locked/);
    const issue = await f.issue('synthetic');
    t.data.issue.fields.project.id = '999';
    await assert.rejects(() => f.cleanup());
    assert.equal(t.deletes, 0);
    t.data.issue.fields.project.id = '777';
    t.data.issue.fields.labels = ['other'];
    await assert.rejects(() => f.cleanup());
    assert.equal(t.deletes, 0);
    t.data.issue.fields.labels = issue.expected.labels;
    await f.cleanup();
    assert.equal(t.deletes, 1);
    const p = join(directory, `${f.run.state.runId}.json`);
    const state = JSON.parse(readFileSync(p));
    state.site = 'https://foreign-example.atlassian.net';
    writeFileSync(p, JSON.stringify(state));
    await assert.rejects(
      () => openRun(t.request, 'forge-sandbox', { directory, recover: state.runId }),
      /ownership mismatch/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('external dependents stop cleanup, then exact owned state can resume', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixture-'));
  const t = transport();
  try {
    const f = await openRun(t.request, 'forge-sandbox', { directory });
    await f.issue('synthetic');
    t.data.issue.fields.subtasks = [{ id: '999' }];
    await assert.rejects(() => f.cleanup());
    assert.equal(t.deletes, 0);
    t.data.issue.fields.subtasks = [];
    t.data.issue.fields.priority = { id: 'changed' };
    await assert.rejects(() => f.cleanup());
    assert.equal(t.deletes, 0);
    delete t.data.issue.fields.priority;
    await f.cleanup();
    assert.equal(f.run.state.status, 'clean');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a status change recorded before it is made passes cleanup; any other change is refused', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixture-'));
  const t = transport({ app: typedApp, key: 'DEMO' });
  try {
    const f = await openRun(t.request, typedApp, { directory });
    const prompt = await f.propertyIssue('Prompt fixture', 'Synthetic instructions', '39');
    const issue = t.data.issues.get(prompt.id);
    issue.fields.status = { id: '11', name: 'Prompt retired' };
    await assert.rejects(() => f.cleanup(), /cleanup incomplete/, 'unrecorded status');
    prompt.expected.statusIds = ['10', '11'];
    f.run.persist();
    issue.fields.priority = { id: 'changed' };
    await assert.rejects(() => f.cleanup(), /cleanup incomplete/, 'another field changed');
    delete issue.fields.priority;
    issue.fields.status = { id: '12', name: 'Elsewhere' };
    await assert.rejects(() => f.cleanup(), /cleanup incomplete/, 'status outside the intent');
    assert.equal(t.deletes, 0);
    // A renamed status keeps its ID.
    issue.fields.status = { id: '11', name: 'Retired', self: 'https://example.test/status/11' };
    await f.cleanup();
    assert.equal(t.deletes, 1);
    assert.equal(f.run.state.status, 'clean');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('recovery refuses a live lock owner and resumes an interrupted dead owner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixture-'));
  const t = transport();
  try {
    const f = await openRun(t.request, 'forge-sandbox', { directory });
    await f.issue('synthetic');
    await assert.rejects(
      () => openRun(t.request, 'forge-sandbox', { directory, recover: f.run.state.runId }),
      /still running/,
    );
    writeFileSync(
      join(directory, '777.lock'),
      JSON.stringify({ runId: f.run.state.runId, pid: 2147483647 }),
    );
    const resumed = await openRun(t.request, 'forge-sandbox', {
      directory,
      recover: f.run.state.runId,
    });
    await resumed.cleanup();
    assert.equal(t.deletes, 1);
    assert.equal(resumed.run.state.status, 'clean');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an unrecorded custom field value is cleaned up only when the run alone changed the work item', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixture-'));
  const t = transport();
  const changed = (accountId, at) => [
    { author: { accountId }, created: new Date(at).toISOString(), items: [] },
  ];
  try {
    const f = await openRun(t.request, 'forge-sandbox', { directory });
    await f.issue('synthetic');
    const entry = f.run.state.resources[0];
    entry.expected.customField = { id: 'customfield_1', value: ['SBOX-1'] };
    f.run.persist();
    // The save landed, but its test stopped before recording the cleared value.
    t.data.issue.fields.customfield_1 = null;
    const started = Date.parse(f.run.state.started);
    for (const history of [
      [],
      changed('someone-else', started + 1),
      changed('test-owner', started - 60000),
    ]) {
      t.data.changelogs.set(entry.id, history);
      await assert.rejects(() => f.cleanup(), /incomplete/);
    }
    assert.equal(t.deletes, 0);
    // A recovered run counts only changes made before it finished.
    const recover = () => {
      writeFileSync(
        join(directory, '777.lock'),
        JSON.stringify({ runId: f.run.state.runId, pid: 2147483647 }),
      );
      return openRun(t.request, 'forge-sandbox', { directory, recover: f.run.state.runId });
    };
    const finished = Date.parse(f.run.state.finished);
    t.data.changelogs.set(entry.id, changed('test-owner', finished + 60000));
    await assert.rejects(async () => (await recover()).cleanup(), /incomplete/);
    assert.equal(t.deletes, 0);
    t.data.changelogs.set(entry.id, changed('test-owner', started + 1));
    const resumed = await recover();
    await resumed.cleanup();
    assert.equal(t.deletes, 1);
    assert.equal(resumed.run.state.status, 'clean');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Jira label ordering does not block cleanup but changed exact labels still do', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixture-'));
  const t = transport();
  try {
    const f = await openRun(t.request, 'forge-sandbox', { directory });
    const issue = await f.issue('synthetic', ['z-last', 'A-first']);
    t.data.issue.fields.labels = [...issue.expected.labels].reverse();
    t.data.issue.fields.labels.push('unexpected');
    await assert.rejects(() => f.cleanup());
    assert.equal(t.deletes, 0);
    t.data.issue.fields.labels = t.data.issue.fields.labels.filter((x) => x !== 'unexpected');
    await f.cleanup();
    assert.equal(t.deletes, 1);
    assert.equal(f.run.state.status, 'clean');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fixture transport accepts an empty 201 property response without retrying writes', async () => {
  let calls = 0;
  let body = '';
  const api = client({
    fetch: async () => {
      calls++;
      return { ok: () => true, status: () => 201, text: async () => body };
    },
  });
  assert.equal(
    await api(`/issue/888/properties/${markers.fixtureProperty}`, 'PUT', { marker: 'owned' }),
    null,
  );
  assert.equal(calls, 1);
  body = '{"id":"888"}';
  assert.deepEqual(await api('/issue', 'POST', {}), { id: '888' });
  body = 'private invalid content';
  await assert.rejects(() => api('/issue', 'POST', {}), {
    message:
      'Verification transport failed (POST HTTP 201 JSON parse: SyntaxError). Request diagnostics suppressed to protect credentials.',
  });
  assert.equal(calls, 3);
});

// Fixtures created under an earlier namespace carry its markers (legacyNamespaces). They must
// stay verifiable and removable while every new write uses the current markers.
test('pre-rename fixtures verify and clean up; new fixtures are written with current markers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixture-'));
  const t = transport({
    app: typedApp,
    key: 'DEMO',
    description: legacyMarker(markers.browserProject(typedApp)),
  });
  try {
    const f = await openRun(t.request, typedApp, { directory });
    const plain = await f.issue('Plain fixture');
    assert.deepEqual(t.data.posts[0].fields.description, {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: markers.disposableIssue(plain.expected.marker) }],
        },
      ],
    });
    const prompt = await f.propertyIssue('Prompt fixture', 'Synthetic instructions', '39');
    assert.deepEqual(t.data.posts[1].properties, [
      { key: markers.fixtureProperty, value: { marker: prompt.expected.marker } },
    ]);
    // As if created before the rename: the run marker sits under the pre-rename property key.
    const issue = t.data.issues.get(prompt.id);
    issue.properties = {
      [legacyMarker(markers.fixtureProperty)]: issue.properties[markers.fixtureProperty],
    };
    await f.cleanup();
    assert.equal(t.deletes, 2);
    assert.equal(f.run.state.status, 'clean');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unrelated space and property markers are still refused', async () => {
  for (const description of ['unrelated', legacyMarker(markers.browserProject('other-app'))])
    await assert.rejects(
      () => openRun(transport({ description }).request, 'forge-sandbox'),
      /Owned/,
    );
  for (const properties of [
    {},
    { 'other.fixture': 'owned' },
    { [legacyMarker(markers.fixtureProperty)]: { marker: 'oa-e2e-another-run-0' } },
  ]) {
    const directory = mkdtempSync(join(tmpdir(), 'fixture-'));
    const t = transport({ app: typedApp, key: 'DEMO' });
    try {
      const f = await openRun(t.request, typedApp, { directory });
      const prompt = await f.propertyIssue('Prompt fixture', 'Synthetic instructions', '39');
      t.data.issues.get(prompt.id).properties = properties;
      await assert.rejects(() => f.cleanup(), /cleanup incomplete/);
      assert.equal(t.deletes, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("journal recovery refuses unsupported resource kinds and another run's work item marker", async () => {
  for (const [resource, error] of [
    [{ kind: 'version', id: '5000', status: 'removed', expected: {} }, /Invalid journal resource/],
    [
      (runId) => {
        const marker = markers.runMarker(runId.replace(/^[0-9a-f]{8}/, '00000000'), 0);
        return {
          kind: 'issue',
          id: '5000',
          status: 'removed',
          expected: { marker, labels: [marker] },
        };
      },
      /Invalid work item ownership marker/,
    ],
    [
      (runId) => {
        const marker = markers.runMarker(runId, 0);
        return {
          kind: 'issue',
          id: null,
          status: 'creating',
          expected: { marker, labels: [], summaryMarker: true, summary: 'Form', typeId: '1' },
        };
      },
      /Invalid work item ownership marker/,
    ],
    [
      (runId) => {
        const marker = markers.runMarker(runId, 0);
        return {
          kind: 'issue',
          id: '5000',
          status: 'removed',
          expected: { marker, labels: [marker], statusIds: [10] },
        };
      },
      /Invalid work item status intent/,
    ],
  ]) {
    const directory = mkdtempSync(join(tmpdir(), 'fixture-'));
    const t = transport();
    try {
      const f = await openRun(t.request, 'forge-sandbox', { directory });
      const runId = f.run.state.runId;
      f.run.state.resources.push(typeof resource === 'function' ? resource(runId) : resource);
      f.run.persist();
      await f.releaseForRecovery();
      await assert.rejects(
        openRun(t.request, 'forge-sandbox', { directory, recover: runId }),
        error,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('registered profiles select their own marked space and refuse when not allowed', async () => {
  registerProfile('tenant-isolation', {
    project: () => 'ISO',
    marker: () => markers.browserProject('tenant-isolation'),
    allow: ({ host }) => {
      if (process.env.ISOLATION_TEST !== '1' || !host) throw Error('Explicit isolation required');
    },
    missing: 'Marked isolation fixture required.',
  });
  assert.throws(() => registerProfile('standard', {}), /Invalid fixture profile/);
  assert.throws(() => registerProfile('partial', { project: () => 'X' }), /needs project/);
  const directory = mkdtempSync(join(tmpdir(), 'fixture-'));
  const t = transport({ key: 'ISO', description: markers.browserProject('tenant-isolation') });
  try {
    await assert.rejects(
      () => openRun(t.request, 'forge-sandbox', { directory, profile: 'tenant-isolation' }),
      /Explicit isolation required/,
    );
    await assert.rejects(
      () => openRun(t.request, 'forge-sandbox', { directory, profile: 'unregistered' }),
      /Unsupported fixture profile/,
    );
    process.env.ISOLATION_TEST = '1';
    const f = await openRun(t.request, 'forge-sandbox', { directory, profile: 'tenant-isolation' });
    await f.issue('synthetic');
    await f.releaseForRecovery();
    // Recovery takes the saved profile, never a caller's.
    const resumed = await openRun(t.request, 'forge-sandbox', {
      directory,
      recover: f.run.state.runId,
    });
    await resumed.cleanup();
    assert.equal(resumed.run.state.status, 'clean');
    t.data.project.description = markers.browserProject('forge-sandbox');
    await assert.rejects(
      () => openRun(t.request, 'forge-sandbox', { directory, profile: 'tenant-isolation' }),
      /Marked isolation fixture required/,
    );
  } finally {
    delete process.env.ISOLATION_TEST;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('documented rejections, including a rate-limited 429, are marked definitive; a 500 is not', async () => {
  for (const [status, definitive] of [
    [400, true],
    [429, true],
    [500, false],
    [502, false],
  ]) {
    const api = client({
      fetch: async () => ({ ok: () => false, status: () => status, text: async () => '' }),
    });
    await assert.rejects(api('/issue', 'POST', {}), (error) => {
      assert.equal(error.definitiveRejection, definitive, `HTTP ${status}`);
      return true;
    });
  }
});

test('peer tenant API cannot mutate even if a caller passes a write method', async () => {
  const api = client(
    {
      fetch: () => {
        throw Error('Network must not run');
      },
    },
    `https://${second}`,
  );
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'])
    await assert.rejects(
      api('/issue/123', method, { fields: { summary: 'changed' } }),
      /Peer tenant API is read-only/,
    );
  assert.throws(() => client({}, 'https://unowned.example'), /Owned Jira API site required/);
});

test('a profile that declares a team-managed space accepts only that style', async () => {
  registerProfile('team-managed', {
    project: () => 'TEAM',
    marker: () => markers.browserProject('team-managed'),
    allow: () => {},
    missing: 'Marked team-managed fixture required.',
    style: 'next-gen',
  });
  assert.throws(
    () =>
      registerProfile('odd', {
        project: () => 'X',
        marker: () => 'x',
        allow: () => {},
        missing: 'x',
        style: 'simplified',
      }),
    /classic or next-gen/,
  );
  const directory = mkdtempSync(join(tmpdir(), 'fixture-'));
  const t = transport({ key: 'TEAM', description: markers.browserProject('team-managed') });
  try {
    // The company-managed space a team-managed profile names is refused, and the reverse.
    await assert.rejects(
      () => openRun(t.request, 'forge-sandbox', { directory, profile: 'team-managed' }),
      /Marked team-managed fixture required/,
    );
    t.data.project.style = 'next-gen';
    const f = await openRun(t.request, 'forge-sandbox', { directory, profile: 'team-managed' });
    await f.issue('synthetic');
    await f.cleanup();
    assert.equal(f.run.state.status, 'clean');
    t.data.project.description = markers.browserProject('forge-sandbox');
    t.data.project.key = 'SBOX';
    await assert.rejects(
      () => openRun(t.request, 'forge-sandbox', { directory }),
      /Owned isolated fixture space required/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
