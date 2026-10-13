import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FixtureRun } from '../src/core/run-journal.mjs';
function setup() {
  let saved;
  let item = null;
  let creates = 0;
  let deletes = 0;
  const adapter = {
    create: async (expected) => {
      creates++;
      item = { id: '1', ...expected };
      return item;
    },
    read: async () => item,
    find: async () => (item ? [item] : []),
    verify: async (entry, current = item) => {
      assert.equal(current.marker, entry.expected.marker);
    },
    remove: async () => {
      deletes++;
      item = null;
    },
  };
  const run = FixtureRun.create({
    app: 'test',
    site: 'owned',
    projectId: '2',
    save: (x) => (saved = x),
    adapters: { issue: adapter },
  });
  return {
    run,
    adapter,
    get saved() {
      return saved;
    },
    set item(x) {
      item = x;
    },
    get creates() {
      return creates;
    },
    get deletes() {
      return deletes;
    },
  };
}
test('intent is durable before create, reverse cleanup independently verified', async () => {
  const s = setup();
  const create = s.adapter.create;
  s.adapter.create = async (e) => {
    assert.equal(s.saved.resources[0].status, 'creating');
    return create(e);
  };
  await s.run.create('issue', { marker: 'ours' });
  await s.run.cleanup();
  assert.equal(s.saved.status, 'clean');
  assert.equal(s.deletes, 1);
  await s.run.cleanup();
  assert.equal(s.deletes, 1);
});
test('ambiguous POST reconciles without duplicate creation', async () => {
  const s = setup();
  const create = s.adapter.create;
  s.adapter.create = async (e) => {
    await create(e);
    throw Error('lost response');
  };
  await assert.rejects(() => s.run.create('issue', { marker: 'ours' }));
  await s.run.cleanup();
  assert.equal(s.creates, 1);
  assert.equal(s.deletes, 1);
});
test('unmatched or duplicate uncertain create blocks cleanup and never repeats POST', async () => {
  for (const found of [[], [{ id: '1' }, { id: '2' }]]) {
    const s = setup();
    s.adapter.create = async () => {
      throw Error('network');
    };
    s.adapter.find = async () => found;
    await assert.rejects(() => s.run.create('issue', { marker: 'ours' }));
    await assert.rejects(() => s.run.cleanup(), /incomplete/);
    assert.equal(s.deletes, 0);
    assert.equal(s.saved.status, 'cleanup-required');
  }
});
test('changed ownership refuses delete', async () => {
  const s = setup();
  await s.run.create('issue', { marker: 'ours' });
  s.item = { id: '1', marker: 'other' };
  await assert.rejects(() => s.run.cleanup());
  assert.equal(s.deletes, 0);
});
test('lost DELETE response resumes from durable deleting state', async () => {
  const s = setup();
  await s.run.create('issue', { marker: 'ours' });
  s.adapter.remove = async () => {
    s.item = null;
    throw Error('lost response');
  };
  await assert.rejects(() => s.run.cleanup());
  const resumed = new FixtureRun({
    state: s.saved,
    save: () => {},
    adapters: { issue: s.adapter },
  });
  await resumed.cleanup();
  assert.equal(resumed.state.status, 'clean');
});
test('failed deletion remains incomplete and setup failure still cleans earlier resources', async () => {
  const s = setup();
  await s.run.create('issue', { marker: 'ours' });
  s.adapter.remove = async () => {};
  await assert.rejects(() => s.run.cleanup());
  assert.equal(s.saved.status, 'cleanup-required');
  assert.match(s.saved.leftovers[0].reason, /not independently confirmed/);
  s.adapter.remove = async () => {
    s.item = null;
  };
  await s.run.cleanup();
  assert.equal(s.saved.status, 'clean');
});

test('bounded independent-issue cleanup drains failures and preserves per-resource verification', async () => {
  const resources = Array.from({ length: 9 }, (_, i) => ({
    kind: 'issue',
    id: String(i + 1),
    status: 'created',
    expected: {},
  }));
  const present = new Set(resources.map((x) => x.id));
  let active = 0,
    peak = 0;
  const verified = new Set();
  const run = new FixtureRun({
    state: { runId: 'bounded', status: 'active', resources },
    save: () => {},
    adapters: {
      issue: {
        read: async (id) => (present.has(id) ? { id } : null),
        verify: async (entry) => {
          if (entry.id === '5') throw Error('foreign content');
          verified.add(entry.id);
        },
        remove: async (entry) => {
          assert.ok(verified.has(entry.id));
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          present.delete(entry.id);
          active--;
        },
      },
    },
  });
  await assert.rejects(run.cleanup({ concurrency: 4 }), /cleanup incomplete/);
  assert.equal(active, 0);
  assert.equal(peak, 4);
  assert.deepEqual([...present], ['5']);
  assert.equal(run.state.status, 'cleanup-required');
  assert.equal(resources.filter((x) => x.status === 'removed').length, 8);
});
test('parallel cleanup refuses dependent kinds and unbounded concurrency before actions', async () => {
  const run = new FixtureRun({
    state: { resources: [{ kind: 'settings' }], status: 'active' },
    save: () => {},
    adapters: {},
  });
  await assert.rejects(run.cleanup({ concurrency: 2 }), /independent issue/);
  await assert.rejects(run.cleanup({ concurrency: 5 }), /independent issue/);
  assert.equal(run.state.status, 'active');
});
