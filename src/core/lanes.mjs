import { resolve } from 'node:path';
import { browserTarget } from './target.mjs';

// Browser lanes. Each lane is one Playwright project, built only when selected (E2E_LANE) and
// only after its explicit checks, so discovery (--list) refuses exactly as execution does.
// Reports and results stay under the private state root.
function check(ok, message) {
  if (!ok) throw Error(message);
}
const browser = {
  channel: 'chrome',
  headless: true,
  viewport: { width: 1440, height: 1100 },
  trace: 'off',
  screenshot: 'only-on-failure',
};

// Disposable-fixture lanes share the feature options and the selected site's private paths.
function featureLane(env, kind) {
  const target = browserTarget(env.PLUGIN_TEST_SITE || undefined);
  return {
    testMatch: '**/*.features.spec.mjs',
    timeout: 300_000,
    use: {
      ...browser,
      storageState: target.auth,
      actionTimeout: 15_000,
      navigationTimeout: 45_000,
    },
    outputDir: resolve(target.results(`${kind}-results`)),
    report: resolve(target.results(`${kind}-report.json`)),
  };
}

export const lanes = {
  features: (env) => featureLane(env, 'feature'),
  compatibility(env) {
    const engine = env.COMPAT_BROWSER;
    check(
      ['chrome', 'firefox', 'webkit'].includes(engine),
      'Select COMPAT_BROWSER=chrome, firefox or webkit; WebKit is not actual Safari acceptance.',
    );
    const lane = featureLane(env, `compatibility-${engine}`);
    const { channel, ...use } = lane.use;
    return {
      ...lane,
      use:
        engine === 'chrome'
          ? { ...use, browserName: 'chromium', channel }
          : { ...use, browserName: engine },
    };
  },
};

/** Lanes named by E2E_LANE (comma-separated; default features). */
export function selectedLanes(env) {
  const names = (env.E2E_LANE || 'features').split(',');
  for (const name of names)
    check(Object.hasOwn(lanes, name), `Unknown browser lane ${name}: ${Object.keys(lanes)}.`);
  check(new Set(names).size === names.length, 'Select each browser lane once.');
  return names;
}

/** A lane's Playwright project and JSON report path; throws the lane's refusal. */
export function laneProject(name, env) {
  check(Object.hasOwn(lanes, name), `Unknown browser lane ${name}.`);
  const { report, ...project } = lanes[name](env);
  return { project: { name, ...project }, report };
}

/**
 * A Playwright configuration with one project per selected lane: one worker, no retries, stop at
 * the first failure and keep its evidence. Fixtures are never retried blindly.
 */
export function definePlaywrightConfig({ testDir }, env = process.env) {
  const selected = selectedLanes(env).map((lane) => laneProject(lane, env));
  return {
    testDir,
    fullyParallel: false,
    workers: 1,
    retries: 0,
    maxFailures: 1,
    expect: { timeout: 30_000 },
    // Playwright reporters are run-wide, so a JSON report is written for single-lane runs only.
    reporter:
      selected.length === 1 ? [['list'], ['json', { outputFile: selected[0].report }]] : [['list']],
    projects: selected.map((lane) => lane.project),
  };
}
