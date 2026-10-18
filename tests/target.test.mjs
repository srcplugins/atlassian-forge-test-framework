import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { environmentId, primary, second } from './support/config.mjs';
import { browserTarget, selectInstallation } from '../src/core/target.mjs';
import { installArguments, installOptions, installedOn } from '../src/core/forge-install.mjs';
import { installationTargets } from '../src/core/config.mjs';

test('browser targets keep each site in its own private state directory', () => {
  const a = browserTarget(primary);
  const b = browserTarget(second);
  assert.equal(a.runs, resolve(`.local/test-state/sites/${primary}/e2e/runs`));
  assert.equal(a.auth, resolve(`.local/test-state/sites/${primary}/browser-auth/admin.json`));
  for (const field of ['directory', 'runs', 'authDirectory', 'auth'])
    assert.notEqual(a[field], b[field]);
  assert.equal(browserTarget().host, primary);
  assert.throws(() => browserTarget('example.atlassian.net'), /Owned/);
  assert.throws(() => browserTarget('../outside'), /Owned/);
});

test('installation selection never falls back across tenant or environment', () => {
  const targets = installationTargets();
  assert.equal(
    selectInstallation(targets, 'demo-app', primary, 'development').environmentId,
    environmentId,
  );
  assert.equal(selectInstallation(targets, 'demo-app', second, 'production').site, second);
  assert.throws(
    () => selectInstallation(targets, 'demo-app', primary, 'production'),
    /Exactly one/,
  );
  assert.throws(
    () => selectInstallation([...targets, targets[0]], 'demo-app', primary),
    /Exactly one/,
  );
  assert.throws(() => selectInstallation(targets, 'demo-app', primary, ''), /Unsupported/);
  assert.throws(
    () => selectInstallation(targets, 'demo-app', 'bad-example.atlassian.net'),
    /Owned/,
  );
});

test('install targets default to primary development and explicitly select production', () => {
  assert.deepEqual(installOptions([]), {
    site: primary,
    role: 'primary',
    environment: 'development',
    upgrade: false,
  });
  for (const flags of [['-e', 'production'], ['--environment=production']]) {
    const options = installOptions(['--role', 'isolation', ...flags]);
    const base = ['install', '--non-interactive'];
    const rest = ['--site', second, '--product', 'jira', '-e', 'production'];
    assert.deepEqual(installArguments(options, false), [...base, ...rest]);
    assert.deepEqual(installArguments(options, true), [...base, '--upgrade', ...rest]);
  }
  assert.ok(installArguments(installOptions(['--upgrade']), false).includes('--upgrade'));
  for (const args of [
    ['--role'],
    ['--role', '--upgrade'],
    ['--role', 'unknown'],
    ['-e', ''],
    ['-e', 'prod'],
    ['-e', 'production', '--environment', 'development'],
    ['--site', 'elsewhere-example.atlassian.net'],
    ['--role=primary', '--role=isolation'],
    ['--upgrade=true'],
    ['--product', 'confluence'],
  ])
    assert.throws(() => installOptions(args), args.join(' '));
});

test('existing install detection is exact for site, environment and product', () => {
  const dev = { site: second, environment: 'development', product: 'Jira' };
  const prod = { ...dev, environment: 'production' };
  assert.equal(installedOn([dev], second, 'production'), false);
  assert.equal(installedOn([dev, prod], second, 'production'), true);
  assert.equal(installedOn([prod], primary, 'production'), false);
  assert.equal(
    installedOn([{ ...prod, product: 'Jira Service Management' }], second, 'production'),
    false,
  );
  assert.throws(() => installedOn(null, second, 'production'));
  for (const row of [null, {}, { ...prod, site: null }, { ...prod, environment: '' }])
    assert.throws(() => installedOn([row], second, 'production'), /Malformed/);
  assert.throws(() => installedOn([prod, prod], second, 'production'), /Ambiguous/);
});
