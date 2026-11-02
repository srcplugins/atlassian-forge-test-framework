import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// A hosted suite is an ordered list of steps:
// { name, command: [executable, ...args], env, prerequisite, cleanup }.
// Each step gets its own run ID in FORGE_TEST_RUN_ID, which a runner uses for its journal. A
// failed prerequisite stops the suite. Any other failed step is settled before the suite moves
// on: `cleanup: [executable, ...args]` runs that guarded cleanup with the run ID appended, and
// `cleanup: 'fixtures'` requires every fixture journal to be clean. A step that can't be settled,
// or declares no cleanup, stops the suite, so its journals and evidence stay for inspection.
// Nothing is retried. The summary carries step names and timings only, never output, plus the
// readiness stage at which a test's app wasn't ready, which the test records itself
// (`recordStepResult`, through the file named in FORGE_TEST_STEP_RESULT).
//
// Between steps the suite may pause for another run (`pause`). That run may deploy over this
// one, so after a pause the prerequisites that already passed run again before the next step.

/** Prints the steps without running them. */
export function listSuite(steps, log = console.log) {
  for (const s of steps)
    log(
      `${s.name}: ${Object.entries(s.env ?? {})
        .map(([k, v]) => `${k}=${v} `)
        .join('')}${s.command.join(' ')}`,
    );
}

/**
 * The prerequisites plus the steps whose names contain one of the comma-separated terms (case
 * ignored). A term that selects nothing is refused, so a typo can't pass as a short green run.
 */
export function selectSteps(steps, only) {
  if (!only) return steps;
  const terms = only
    .split(',')
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  if (!terms.length) throw Error('--only needs at least one step name');
  const matches = (s, term) => !s.prerequisite && s.name.toLowerCase().includes(term);
  for (const term of terms)
    if (!steps.some((s) => matches(s, term))) throw Error(`No step matches "${term}"`);
  return steps.filter((s) => s.prerequisite || terms.some((term) => matches(s, term)));
}

/**
 * Inside a suite step, records why it failed for the suite's summary and receipt: each record is
 * `{ kind: 'app-readiness', test, stage }`, appended to the file the suite names in
 * FORGE_TEST_STEP_RESULT. Outside a suite it does nothing. A record that can't be written is
 * reported and doesn't change the test's result.
 */
export function recordStepResult(records, env = process.env) {
  if (!env.FORGE_TEST_STEP_RESULT || !records.length) return;
  try {
    appendFileSync(
      env.FORGE_TEST_STEP_RESULT,
      records.map((record) => `${JSON.stringify(record)}\n`).join(''),
    );
  } catch {
    console.error('Could not record the step result for the suite.');
  }
}

// The readiness failures a step recorded: names and fixed stage words only.
function stepReadiness(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        const { kind, test, stage } = JSON.parse(line);
        return kind === 'app-readiness' &&
          typeof test === 'string' &&
          test.length <= 200 &&
          /^[a-z]{1,20}$/.test(stage)
          ? [{ test, stage }]
          : [];
      } catch {
        return [];
      }
    });
}

const exitCode = (command, args, options) =>
  new Promise((done) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' });
    child.on('error', () => done(1));
    child.on('close', (code) => done(code ?? 1));
  });

/**
 * Runs the steps in order and resolves whether all passed. `before` runs ahead of each step and
 * each cleanup; if it throws, the suite stops there (for example when the site lease was lost).
 * `pause` runs ahead of each step after the first that isn't a prerequisite, and resolves true
 * when the suite paused for another run, false when it didn't. `fixturesClean` answers whether
 * every fixture journal is clean.
 */
export async function runSuite(
  title,
  steps,
  {
    cwd = process.cwd(),
    env = process.env,
    before = () => {},
    pause = async () => false,
    fixturesClean = () => false,
    runId = randomUUID,
    receipt,
    now = () => new Date(),
  } = {},
) {
  const results = [];
  const guarded = async (label) => {
    try {
      await before();
      return true;
    } catch (error) {
      console.error(`Stopped before ${label}: ${error.message}`);
      return false;
    }
  };
  const prerequisites = [];
  const pauses = [];
  // False when the suite must stop: the pause threw, or a prerequisite failed when run again.
  const resumed = async (s) => {
    const started = performance.now();
    try {
      if (!(await pause())) return true;
    } catch (error) {
      console.error(`Stopped before ${s.name}: ${error.message}`);
      return false;
    }
    let ok = true;
    for (const p of prerequisites) {
      if (!(ok = await guarded(`${p.name} after the pause`))) break;
      console.log(`\n=== ${p.name} (again, after the pause)`);
      const stepEnv = { ...env, ...p.env, FORGE_TEST_RUN_ID: runId() };
      ok = (await exitCode(p.command[0], p.command.slice(1), { cwd, env: stepEnv })) === 0;
      if (!ok) break;
    }
    pauses.push({
      before: s.name,
      ok,
      seconds: (performance.now() - started) / 1000,
      // The pause starts as the step before it ends.
      started: results.at(-1).finished,
      finished: now().toISOString(),
    });
    return ok;
  };
  // Each step's FORGE_TEST_STEP_RESULT file, where its tests record why they failed.
  const stepResults = mkdtempSync(join(tmpdir(), 'forge-test-steps-'));
  for (const s of steps) {
    if (!(await guarded(s.name))) break;
    if (!s.prerequisite && results.length && !(await resumed(s))) break;
    console.log(`\n=== ${s.name}`);
    const id = runId();
    const stepResult = join(stepResults, `${results.length}.jsonl`);
    const stepEnv = { ...env, ...s.env, FORGE_TEST_RUN_ID: id, FORGE_TEST_STEP_RESULT: stepResult };
    const startedAt = now().toISOString();
    const started = performance.now();
    const code = await exitCode(s.command[0], s.command.slice(1), { cwd, env: stepEnv });
    const result = {
      ok: code === 0,
      seconds: (performance.now() - started) / 1000,
      started: startedAt,
      finished: now().toISOString(),
    };
    const readiness = stepReadiness(stepResult);
    if (readiness.length) result.readiness = readiness;
    results.push(result);
    if (result.ok && s.prerequisite) prerequisites.push(s);
    if (result.ok) continue;
    if (s.prerequisite || !s.cleanup) break;
    if (s.cleanup === 'fixtures') {
      result.settled = await fixturesClean();
      if (!result.settled) console.error(`A fixture journal is not clean after ${s.name}.`);
    } else {
      if (!(await guarded(`the cleanup of ${s.name}`))) break;
      console.log(`\n=== Cleanup after ${s.name}`);
      const [command, ...args] = s.cleanup;
      result.settled = (await exitCode(command, [...args, id], { cwd, env: stepEnv })) === 0;
    }
    if (!result.settled) break;
  }
  rmSync(stepResults, { recursive: true, force: true });
  const outcome = (r) =>
    !r ? 'not run' : r.ok ? 'passed' : r.settled ? '**failed**, cleaned up' : '**failed**';
  const notReady = (r) =>
    r?.readiness
      ? `; app not ready (${r.readiness.map((x) => `${x.test}: ${x.stage}`).join(', ')})`
      : '';
  const lines = [
    `| ${title} | Result | Minutes |`,
    '|---|---|---|',
    ...steps.map((s, i) => {
      const r = results[i];
      return `| ${s.name} | ${outcome(r)}${notReady(r)} | ${r ? (r.seconds / 60).toFixed(1) : ''} |`;
    }),
    ...pauses.map(
      (p) =>
        `| Paused before ${p.before}, then the prerequisites again | ${p.ok ? 'passed' : '**failed**'} | ${(p.seconds / 60).toFixed(1)} |`,
    ),
  ];
  console.log(`\n${lines.join('\n')}`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  const passed = results.length === steps.length && results.every((r) => r.ok);
  if (receipt) writeReceipt(receipt, { title, cwd, passed, steps, results, pauses });
  return passed;
}

/**
 * Records the run as JSON for measuring first-pass rates and repair time: the suite, the
 * directory it ran in, each step's outcome and times, the tests whose app wasn't ready with the
 * stage that failed, and any pauses for another run. Names, timings and stage words only, like
 * the summary. A receipt that can't be written is reported and doesn't change
 * the result.
 */
function writeReceipt(file, { title, cwd, passed, steps, results, pauses }) {
  const outcome = (r) =>
    !r ? 'not run' : r.ok ? 'passed' : r.settled ? 'failed, cleaned up' : 'failed';
  const record = {
    schemaVersion: 1,
    suite: title,
    directory: basename(cwd),
    ok: passed,
    steps: steps.map((s, i) => ({
      name: s.name,
      outcome: outcome(results[i]),
      ...(results[i] ? { started: results[i].started, finished: results[i].finished } : {}),
      // Each test whose app wasn't ready, and the readiness stage it failed at.
      ...(results[i]?.readiness ? { readiness: results[i].readiness } : {}),
    })),
    ...(pauses.length
      ? {
          pauses: pauses.map((p) => ({
            before: p.before,
            outcome: p.ok ? 'passed' : 'failed',
            started: p.started,
            finished: p.finished,
          })),
        }
      : {}),
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    console.error('Could not write the suite receipt.');
  }
}
