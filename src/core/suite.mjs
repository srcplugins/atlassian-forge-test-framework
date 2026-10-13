import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

// A hosted suite is an ordered list of steps: { name, command: [executable, ...args], env }.
// It stops at the first failure so a failed run's journals and evidence stay for inspection, and
// never retries. The summary carries step names and timings only, never output.

/** Prints the steps without running them. */
export function listSuite(steps, log = console.log) {
  for (const s of steps)
    log(
      `${s.name}: ${Object.entries(s.env ?? {})
        .map(([k, v]) => `${k}=${v} `)
        .join('')}${s.command.join(' ')}`,
    );
}

const exitCode = (command, args, options) =>
  new Promise((done) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' });
    child.on('error', () => done(1));
    child.on('close', (code) => done(code ?? 1));
  });

/**
 * Runs the steps in order and resolves whether all passed. `before` runs ahead of each step; if
 * it throws, the suite stops there (for example when the site lease was lost).
 */
export async function runSuite(
  title,
  steps,
  { cwd = process.cwd(), env = process.env, before = () => {} } = {},
) {
  const results = [];
  for (const s of steps) {
    try {
      await before(s);
    } catch (error) {
      console.error(`Stopped before ${s.name}: ${error.message}`);
      break;
    }
    console.log(`\n=== ${s.name}`);
    const started = performance.now();
    const code = await exitCode(s.command[0], s.command.slice(1), {
      cwd,
      env: { ...env, ...s.env },
    });
    results.push({ ok: code === 0, seconds: (performance.now() - started) / 1000 });
    if (code !== 0) break;
  }
  const lines = [
    `| ${title} | Result | Minutes |`,
    '|---|---|---|',
    ...steps.map((s, i) => {
      const r = results[i];
      return `| ${s.name} | ${r ? (r.ok ? 'passed' : '**failed**') : 'not run'} | ${r ? (r.seconds / 60).toFixed(1) : ''} |`;
    }),
  ];
  console.log(`\n${lines.join('\n')}`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  return results.length === steps.length && results.every((r) => r.ok);
}
