import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { primary, second } from './support/config.mjs';
import { definePlaywrightConfig, laneProject, selectedLanes } from '../src/core/lanes.mjs';

test('lanes refuse unowned sites, unknown browsers and unknown lane names', () => {
  assert.throws(
    () => laneProject('features', { PLUGIN_TEST_SITE: 'other.atlassian.net' }),
    /Owned/,
  );
  assert.throws(() => laneProject('compatibility', { COMPAT_BROWSER: 'safari' }), /COMPAT_BROWSER/);
  assert.throws(() => laneProject('unknown', {}), /Unknown/);
  assert.throws(() => selectedLanes({ E2E_LANE: 'features,features' }), /once/);
});

test('every lane keeps reports, results and sessions in the site private state', () => {
  for (const host of [primary, second]) {
    const { project, report } = laneProject('features', { PLUGIN_TEST_SITE: host });
    const base = resolve(`.local/test-state/sites/${host}`);
    assert.ok(report.startsWith(`${base}/e2e/`));
    assert.ok(project.outputDir.startsWith(`${base}/e2e/`));
    assert.equal(project.use.storageState, `${base}/browser-auth/admin.json`);
    assert.equal(project.use.trace, 'off');
  }
});

test('the Playwright configuration is serial, never retries and stops at the first failure', () => {
  const config = definePlaywrightConfig({ testDir: 'tests/hosted' }, { E2E_LANE: 'features' });
  assert.equal(config.workers, 1);
  assert.equal(config.retries, 0);
  assert.equal(config.maxFailures, 1);
  assert.deepEqual(
    config.projects.map((p) => p.name),
    ['features'],
  );
});
