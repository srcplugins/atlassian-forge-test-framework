import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import { config, daysUntilExpiry, landingIssue, ownedSites, siteFor } from '../core/config.mjs';
import { jiraConfig } from '../core/credentials.mjs';
import { laneProject, lanes } from '../core/lanes.mjs';
import { isMarker, markers } from '../core/markers.mjs';
import { safeRequest } from '../core/safe-request.mjs';
import { activeTarget, browserTarget } from '../core/target.mjs';
import { client, projects, tokenRequest } from './client.mjs';
import { openRun } from './run.mjs';
import { sitePreflight } from './site-preflight.mjs';
import { siteLease } from './site-lease.mjs';
import { runSuite } from '../core/suite.mjs';

// Implementations of the forge-test commands (bin/forge-test.mjs). Each refuses anything but an
// owned site and never prints credentials, cookies or response bodies.

/**
 * Runs a suite while holding the site lease, so suites from other repositories or machines on
 * the same site wait. The lease is renewed on a timer and confirmed again right before each
 * step; a failed renewal retries on the next tick, and a lost lease stops the suite before its
 * next step or cleanup.
 */
export async function suite(title, steps, { renewEvery = 5 * 60_000 } = {}) {
  const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: run } = process.env;
  const lease = siteLease(client(await tokenRequest()), {
    holder: repository ? `${repository} run ${run}` : 'a local run',
  });
  await lease.acquire();
  let lost;
  let renewing;
  const renew = () =>
    (renewing = lease.renew().catch((error) => {
      if (error.leaseLost) lost = error;
    }));
  const timer = setInterval(renew, renewEvery);
  try {
    return await runSuite(title, steps, {
      before: async () => {
        await renew();
        if (lost) throw lost;
      },
      fixturesClean: () => fixturesClean(),
    });
  } finally {
    clearInterval(timer);
    // A renewal still in flight must settle before release, so it cannot recreate the lease.
    await renewing;
    await lease
      .release()
      .catch(() => console.error('Could not release the site lease; it expires on its own.'));
  }
}

/** Whether every fixture journal on the site under test is clean (none active or left over). */
export function fixturesClean(directory = activeTarget().runs) {
  if (!existsSync(directory)) return true;
  return readdirSync(directory)
    .filter((name) => /^[0-9a-f-]{36}\.json$/.test(name))
    .every((name) => JSON.parse(readFileSync(`${directory}/${name}`, 'utf8')).status === 'clean');
}

/** Read-only check of the configured account on the API site. */

export async function doctor() {
  const cfg = jiraConfig();
  if (!cfg.email || !cfg.token) throw Error('Set JIRA_EMAIL and JIRA_API_KEY.');
  const get = (path) =>
    safeRequest(() =>
      fetch(`https://${cfg.site}/rest/api/3${path}`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64')}`,
          Accept: 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      }),
    );
  const response = await get('/myself');
  if (!response.ok)
    throw Error(
      `Jira authentication probe: HTTP ${response.status}. Check token expiry, email and scopes.`,
    );
  const user = await safeRequest(() => response.json());
  if (!user.accountId || !user.active) throw Error('Jira did not return an active account.');
  console.log('Jira authentication OK; active account verified.');
  const permissions = await get('/mypermissions?permissions=ADMINISTER');
  if (!permissions.ok) throw Error(`Permission probe: HTTP ${permissions.status}`);
  const admin = (await safeRequest(() => permissions.json())).permissions?.ADMINISTER;
  console.log(`Jira administrator: ${admin?.havePermission === true}`);
}

/** Read-only inventory of one owned site. */
export async function preflight(host) {
  if (!host) throw Error('Usage: forge-test preflight <owned-site>.atlassian.net');
  const { email, token } = jiraConfig();
  console.log(JSON.stringify(await sitePreflight({ site: host, email, token }), null, 2));
}

const profileName = /^[a-z][a-z0-9-]*$/;

/** Opens Chrome for a manual sign-in and saves the session for the site under test. */
export async function login(profile = 'admin') {
  if (!profileName.test(profile)) throw Error('Use a lowercase profile name, such as admin.');
  const target = activeTarget();
  if (jiraConfig().site !== target.host) throw Error('Browser/API site mismatch.');
  mkdirSync(target.authDirectory, { recursive: true, mode: 0o700 });
  chmodSync(target.authDirectory, 0o700);
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${target.site}/browse/${landingIssue()}`);
    console.log(
      `Sign in normally in the opened Chrome window as the ${profile} account. No password is collected.`,
    );
    // Signed in once the landing issue shows its app actions, or Jira returns the signed-in user
    // (an account without access to the landing issue still gets a usable session).
    const deadline = Date.now() + 900_000;
    for (;;) {
      if (await page.getByRole('button', { name: 'View app actions', exact: true }).isVisible())
        break;
      const me = await context.request.get(`${target.site}/rest/api/3/myself`).catch(() => null);
      if (me?.ok() && (await me.json().catch(() => null))?.accountId) break;
      if (Date.now() > deadline) throw Error('Sign-in was not completed within 15 minutes.');
      await page.waitForTimeout(3000);
    }
    const path = `${target.authDirectory}/${profile}.json`;
    await context.storageState({ path, indexedDB: true });
    chmodSync(path, 0o600);
    console.log(`Saved the ${profile} session in the private state directory.`);
  } finally {
    await browser.close();
  }
}

/**
 * Creates once, or verifies, each configured fixture app's marked company-managed project and
 * adds the account to its Administrators role. Unresolved earlier attempts stop it.
 */
export async function prepare() {
  const target = activeTarget();
  const context = await tokenRequest();
  const api = client(context);
  try {
    const user = await api('/myself');
    mkdirSync(target.directory, { recursive: true });
    for (const [app, key] of Object.entries(projects())) {
      let project = await api(`/project/${key}`);
      const journal = `${target.directory}/project-${key}.json`;
      if (!project) {
        if (existsSync(journal))
          throw Error(`Unresolved project creation ${key}; inspect before retry`);
        writeFileSync(journal, JSON.stringify({ app, key, status: 'creating' }), {
          flag: 'wx',
          mode: 0o600,
        });
        await api('/project', 'POST', {
          key,
          name: markers.browserProjectName(app),
          description: markers.browserProject(app),
          projectTypeKey: 'software',
          projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-simplified-kanban-classic',
          leadAccountId: user.accountId,
          assigneeType: 'UNASSIGNED',
        });
        project = await api(`/project/${key}`);
      }
      if (
        !isMarker(project?.description, markers.browserProject(app)) ||
        project.key !== key ||
        project.style !== 'classic'
      )
        throw Error(`Project ownership mismatch ${key}`);
      const roles = await api(`/project/${project.id}/role`);
      const roleId = roles.Administrators?.match(/\/role\/(\d+)$/)?.[1];
      if (!roleId) throw Error('Expected fixture administrator role missing');
      let role = await api(`/project/${project.id}/role/${roleId}`);
      if (!role.actors.some((a) => a.actorUser?.accountId === user.accountId)) {
        const old = existsSync(journal) ? JSON.parse(readFileSync(journal)) : {};
        if (old.roleAttempt)
          throw Error('Unresolved project-role assignment; inspect before retry');
        writeFileSync(
          journal,
          JSON.stringify({ app, key, id: project.id, status: 'verified', roleAttempt: true }),
          { mode: 0o600 },
        );
        await api(`/project/${project.id}/role/${roleId}`, 'POST', { user: [user.accountId] });
        role = await api(`/project/${project.id}/role/${roleId}`);
        if (!role.actors.some((a) => a.actorUser?.accountId === user.accountId))
          throw Error('Fixture administrator assignment unverified');
      }
      writeFileSync(
        journal,
        JSON.stringify({ app, key, id: project.id, status: 'verified', roleId }),
        { mode: 0o600 },
      );
      console.log(`${app}: owned fixture project verified`);
    }
  } finally {
    await context.dispose();
  }
}

/** Guarded cleanup of one journaled run after a hard stop: ownership is rechecked first. */
export async function cleanup(app, runId) {
  if (!app || !runId) throw Error('Usage: forge-test cleanup <fixture-app> <run-id>');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ storageState: activeTarget().auth });
  const apiContext = await tokenRequest();
  try {
    if (
      (await client(context.request)('/myself')).accountId !==
      (await client(apiContext)('/myself')).accountId
    )
      throw Error('Browser/API identity mismatch');
    const fixture = await openRun(apiContext, app, { recover: runId });
    await fixture.cleanup();
    console.log(`Cleanup verified: ${runId}`);
  } finally {
    await apiContext.dispose();
    await browser.close();
  }
}

/**
 * Runs one browser lane with the consumer's Playwright configuration. The lane's opt-ins and the
 * site's expiry are checked first, so a refusal happens before Playwright starts.
 */
export function lane(name, extra = [], { configFile = 'playwright.config.mjs' } = {}) {
  if (!Object.hasOwn(lanes, name ?? ''))
    throw Error(`Usage: forge-test lane <${Object.keys(lanes).join('|')}> [-- Playwright args]`);
  const env = { ...process.env, E2E_LANE: name };
  laneProject(name, env);
  const host = env.PLUGIN_TEST_SITE || env.JIRA_SITE || siteFor('primary');
  const days = daysUntilExpiry(host);
  if (days !== null && days < 0) throw Error(`The site under test expired ${-days} day(s) ago.`);
  if (days !== null && days <= 30)
    console.warn(`WARNING: the site under test expires in ${days} day(s).`);
  const cli = createRequire(resolve('package.json')).resolve('@playwright/test/cli');
  const result = spawnSync(
    process.execPath,
    [cli, 'test', '-c', configFile, `--project=${name}`, ...extra],
    { stdio: 'inherit', env },
  );
  return result.status ?? 1;
}

const limit = 48 * 1024; // GitHub's secret size limit.
const packed = (value) => gzipSync(Buffer.from(value)).toString('base64');
const secretName = (profile) => `JIRA_SESSION_${profile.toUpperCase().replaceAll('-', '_')}`;

function sessionSecret(file) {
  const state = JSON.parse(readFileSync(file, 'utf8'));
  let value = packed(JSON.stringify(state));
  // Local storage is optional for authentication; cookies alone carry the session.
  if (value.length > limit) value = packed(JSON.stringify({ ...state, origins: [] }));
  if (value.length > limit) throw Error(`A saved session is too large for a GitHub secret.`);
  const expiries = state.cookies
    .filter(
      (c) => ['cloud.session.token', 'tenant.session.token'].includes(c.name) && c.expires > 0,
    )
    .map((c) => c.expires * 1000);
  return { value, expires: expiries.length ? new Date(Math.min(...expiries)) : null };
}

/**
 * Copies this configuration, the API credentials, saved sessions and the identity pins into a
 * GitHub Actions environment's secrets through `gh secret set` (values on stdin). Prints names,
 * sizes and session expiry dates only.
 */
export function secrets({ repo, environment, profiles, dryRun }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !profileName.test(environment ?? ''))
    throw Error('Usage: forge-test secrets --repo <owner/name> --env <environment> [--dry-run]');
  const target = browserTarget(siteFor('primary'));
  const { email, token } = jiraConfig();
  if (!email || !token) throw Error('Jira credentials are not configured.');
  const list = [
    { name: 'FORGE_TEST_CONFIG', value: JSON.stringify({ ...config(), state: undefined }) },
    { name: 'JIRA_EMAIL', value: email },
    { name: 'JIRA_API_KEY', value: token },
  ];
  for (const profile of profiles) {
    if (!profileName.test(profile)) throw Error('Invalid profile name.');
    const file = `${target.authDirectory}/${profile}.json`;
    if (!existsSync(file))
      throw Error(`Missing ${profile} session; run forge-test login ${profile}.`);
    const { value, expires } = sessionSecret(file);
    list.push({
      name: secretName(profile),
      value,
      note: expires ? `session expires ${expires.toISOString().slice(0, 10)}` : 'no expiry found',
    });
  }
  const identity = `${target.directory}/identity-fixture.json`;
  if (existsSync(identity))
    list.push({ name: 'JIRA_IDENTITY_FIXTURE', value: packed(readFileSync(identity, 'utf8')) });
  for (const secret of list) {
    const detail = `${secret.name} (${secret.value.length} bytes${secret.note ? `; ${secret.note}` : ''})`;
    if (dryRun) {
      console.log(`Would set ${detail}`);
      continue;
    }
    const result = spawnSync('gh', ['secret', 'set', secret.name, '-R', repo, '-e', environment], {
      input: secret.value,
      stdio: ['pipe', 'ignore', 'inherit'],
    });
    if (result.status !== 0) throw Error(`Setting ${secret.name} failed.`);
    console.log(`Set ${detail}`);
  }
}

/**
 * The reverse of `secrets`, on a CI runner: writes the JIRA_SESSION_* and JIRA_IDENTITY_FIXTURE
 * environment values into the private state layout for the primary site (files mode 0600).
 */
export function restore(env = process.env) {
  const target = browserTarget(siteFor('primary'));
  mkdirSync(target.authDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(target.directory, { recursive: true, mode: 0o700 });
  const unpack = (value) => gunzipSync(Buffer.from(value, 'base64'));
  let sessions = 0;
  for (const [name, value] of Object.entries(env)) {
    const match = /^JIRA_SESSION_([A-Z0-9_]+)$/.exec(name);
    if (!match || !value) continue;
    const profile = match[1].toLowerCase().replaceAll('_', '-');
    writeFileSync(`${target.authDirectory}/${profile}.json`, unpack(value), { mode: 0o600 });
    sessions++;
  }
  if (env.JIRA_IDENTITY_FIXTURE)
    writeFileSync(`${target.directory}/identity-fixture.json`, unpack(env.JIRA_IDENTITY_FIXTURE), {
      mode: 0o600,
    });
  if (!sessions) throw Error('No saved sessions in the environment.');
  console.log(`Restored ${sessions} session(s) for the primary site.`);
}

/**
 * Values a public CI log must never show: owned hosts, environment IDs, pinned account IDs and
 * the fixture project keys (which also hides every issue key in those projects). The workflow
 * masks each (::add-mask::) before anything else runs.
 */
export function maskValues() {
  const values = [...ownedSites(), ...config().installations.map((i) => i.environmentId)];
  const identity = `${browserTarget(siteFor('primary')).directory}/identity-fixture.json`;
  if (existsSync(identity))
    values.push(...Object.values(JSON.parse(readFileSync(identity, 'utf8')).actors ?? {}));
  const { apps, projects, identity: identityKey, landing } = config().fixtures;
  const keys = [
    ...Object.values(apps ?? {}),
    ...Object.values(projects ?? {}),
    identityKey,
    landing?.split('-')[0],
  ];
  // Hosts and IDs are long; a short value would blank ordinary log text, so they need six
  // characters. Project keys are short by nature and are masked from three.
  return [
    ...new Set([
      ...values.filter((v) => typeof v === 'string' && v.length >= 6),
      ...keys.filter((k) => typeof k === 'string' && k.length >= 3),
    ]),
  ];
}
