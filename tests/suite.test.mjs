import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSuite, selectSteps } from '../src/core/suite.mjs';
import { fixturesClean, suiteReceipt } from '../src/jira/commands.mjs';

// Each step appends "<name> <run id>" to a log; `exit` sets its exit code.
const node = (script) => [process.execPath, '-e', script];
const logStep = (log, name, exit = 0) =>
  node(
    `require('fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + ' ' + (process.argv[1] ?? process.env.FORGE_TEST_RUN_ID) + '\\n'); process.exit(${exit})`,
  );

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'suite-'));
  const log = join(dir, 'log');
  writeFileSync(log, '');
  let n = 0;
  return {
    dir,
    log,
    lines: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
    run: (steps, options = {}) =>
      runSuite('test suite', steps, {
        env: { PATH: process.env.PATH },
        runId: () => `run-${++n}`,
        ...options,
      }),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('only selects named steps and always keeps prerequisites', () => {
  const steps = [
    { name: 'Deploy', prerequisite: true },
    { name: 'Setup runner: mixed' },
    { name: 'Setup runner: bulk' },
    { name: 'Rovo runner' },
  ];
  assert.equal(selectSteps(steps, undefined), steps);
  assert.deepEqual(
    selectSteps(steps, 'MIXED, rovo').map((s) => s.name),
    ['Deploy', 'Setup runner: mixed', 'Rovo runner'],
  );
  assert.throws(() => selectSteps(steps, 'mixd'), /No step matches "mixd"/);
  // A prerequisite isn't a selectable step, so naming only one selects nothing.
  assert.throws(() => selectSteps(steps, 'deploy'), /No step matches/);
  assert.throws(() => selectSteps(steps, ' , '), /at least one/);
});

test('a failed step whose cleanup verifies lets the suite continue with its own run ID', async () => {
  const h = harness();
  try {
    const cleanup = node(
      `require('fs').appendFileSync(${JSON.stringify(h.log)}, 'cleanup ' + process.argv[1] + '\\n')`,
    );
    const ok = await h.run([
      { name: 'a', command: logStep(h.log, 'a', 1), cleanup },
      { name: 'b', command: logStep(h.log, 'b') },
    ]);
    assert.equal(ok, false);
    assert.deepEqual(h.lines(), ['a run-1', 'cleanup run-1', 'b run-2']);
  } finally {
    h.done();
  }
});

test('a failed prerequisite, a failed cleanup or a step without cleanup stops the suite', async () => {
  for (const first of [
    { prerequisite: true, cleanup: node('') },
    { cleanup: node('process.exit(1)') },
    {},
    { cleanup: 'fixtures' },
  ]) {
    const h = harness();
    try {
      const ok = await h.run([
        { name: 'a', command: logStep(h.log, 'a', 1), ...first },
        { name: 'b', command: logStep(h.log, 'b') },
      ]);
      assert.equal(ok, false);
      assert.deepEqual(h.lines(), ['a run-1']);
    } finally {
      h.done();
    }
  }
});

test('fixture-journal steps continue only when every journal is clean', async () => {
  const h = harness();
  try {
    let checked = 0;
    await h.run(
      [
        { name: 'a', command: logStep(h.log, 'a', 1), cleanup: 'fixtures' },
        { name: 'b', command: logStep(h.log, 'b') },
      ],
      { fixturesClean: () => ++checked > 0 },
    );
    assert.equal(checked, 1);
    assert.deepEqual(h.lines(), ['a run-1', 'b run-2']);

    const runs = join(h.dir, 'runs');
    assert.equal(fixturesClean(runs), true);
    const journal = (id, status) =>
      writeFileSync(join(runs, `${id}.json`), JSON.stringify({ status }));
    mkdirSync(runs);
    journal('11111111-1111-1111-1111-111111111111', 'clean');
    writeFileSync(join(runs, 'other-report.json'), '{}');
    assert.equal(fixturesClean(runs), true);
    journal('22222222-2222-2222-2222-222222222222', 'cleanup-required');
    assert.equal(fixturesClean(runs), false);
  } finally {
    h.done();
  }
});

test('a lost lease stops the suite before the next cleanup', async () => {
  const h = harness();
  try {
    let calls = 0;
    await h.run(
      [
        { name: 'a', command: logStep(h.log, 'a', 1), cleanup: node('') },
        { name: 'b', command: logStep(h.log, 'b') },
      ],
      {
        before: () => {
          if (++calls > 1) throw Error('lease lost');
        },
      },
    );
    assert.deepEqual(h.lines(), ['a run-1']);
  } finally {
    h.done();
  }
});

test('a receipt records each step outcome and times, and a skipped one as not run', async () => {
  const h = harness();
  try {
    const file = join(h.dir, 'suites', 'receipt.json');
    let tick = 0;
    const ok = await h.run(
      [
        { name: 'deploy', command: logStep(h.log, 'deploy'), prerequisite: true },
        { name: 'journeys', command: logStep(h.log, 'journeys', 1), cleanup: node('') },
        { name: 'runner', command: logStep(h.log, 'runner', 1) },
        { name: 'after', command: logStep(h.log, 'after') },
      ],
      { cwd: h.dir, receipt: file, now: () => new Date(Date.UTC(2026, 9, 22, 0, 0, tick++)) },
    );
    assert.equal(ok, false);
    const receipt = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(receipt.ok, false);
    assert.equal(receipt.suite, 'test suite');
    assert.match(receipt.directory, /^suite-/);
    assert.deepEqual(
      receipt.steps.map((s) => [s.name, s.outcome, s.started, s.finished]),
      [
        ['deploy', 'passed', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:01.000Z'],
        ['journeys', 'failed, cleaned up', '2026-10-22T00:00:02.000Z', '2026-10-22T00:00:03.000Z'],
        ['runner', 'failed', '2026-10-22T00:00:04.000Z', '2026-10-22T00:00:05.000Z'],
        ['after', 'not run', undefined, undefined],
      ],
    );
    // Names and timings only: no output, environment or run IDs.
    assert.doesNotMatch(readFileSync(file, 'utf8'), /run-\d|PATH/);
  } finally {
    h.done();
  }
});

test('receipt files are named by suite, time and process, inside the site state', () => {
  const at = new Date(Date.UTC(2026, 9, 22, 1, 2, 3, 4));
  assert.equal(
    suiteReceipt('features suite (only AP-17)', at, '/state/e2e'),
    `/state/e2e/suites/features-suite-only-ap-17-2026-10-22T01-02-03.004Z-${process.pid}.json`,
  );
});
