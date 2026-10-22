import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// A hosted suite is an ordered list of steps:
// { name, command: [executable, ...args], env, prerequisite, cleanup }.
// Each step gets its own run ID in FORGE_TEST_RUN_ID, which a runner uses for its journal. A
// failed prerequisite stops the suite. Any other failed step is settled before the suite moves
// on: `cleanup: [executable, ...args]` runs that guarded cleanup with the run ID appended, and
// `cleanup: 'fixtures'` requires every fixture journal to be clean. A step that can't be settled,
// or declares no cleanup, stops the suite, so its journals and evidence stay for inspection.
// Nothing is retried. The summary carries step names and timings only, never output.

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

const exitCode = (command, args, options) =>
  new Promise((done) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' });
    child.on('error', () => done(1));
    child.on('close', (code) => done(code ?? 1));
  });

/**
 * Runs the steps in order and resolves whether all passed. `before` runs ahead of each step and
 * each cleanup; if it throws, the suite stops there (for example when the site lease was lost).
 * `fixturesClean` answers whether every fixture journal is clean.
 */
export async function runSuite(
  title,
  steps,
  {
    cwd = process.cwd(),
    env = process.env,
    before = () => {},
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
  for (const s of steps) {
    if (!(await guarded(s.name))) break;
    console.log(`\n=== ${s.name}`);
    const id = runId();
    const stepEnv = { ...env, ...s.env, FORGE_TEST_RUN_ID: id };
    const startedAt = now().toISOString();
    const started = performance.now();
    const code = await exitCode(s.command[0], s.command.slice(1), { cwd, env: stepEnv });
    const result = {
      ok: code === 0,
      seconds: (performance.now() - started) / 1000,
      started: startedAt,
      finished: now().toISOString(),
    };
    results.push(result);
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
  const outcome = (r) =>
    !r ? 'not run' : r.ok ? 'passed' : r.settled ? '**failed**, cleaned up' : '**failed**';
  const lines = [
    `| ${title} | Result | Minutes |`,
    '|---|---|---|',
    ...steps.map((s, i) => {
      const r = results[i];
      return `| ${s.name} | ${outcome(r)} | ${r ? (r.seconds / 60).toFixed(1) : ''} |`;
    }),
  ];
  console.log(`\n${lines.join('\n')}`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  const passed = results.length === steps.length && results.every((r) => r.ok);
  if (receipt) writeReceipt(receipt, { title, cwd, passed, steps, results });
  return passed;
}

/**
 * Records the run as JSON for measuring first-pass rates and repair time: the suite, the
 * directory it ran in, and each step's outcome and times. Names and timings only, like the
 * summary. A receipt that can't be written is reported and doesn't change the result.
 */
function writeReceipt(file, { title, cwd, passed, steps, results }) {
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
    })),
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    console.error('Could not write the suite receipt.');
  }
}
