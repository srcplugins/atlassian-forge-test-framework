import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { chromium, request as playwrightRequest } from '@playwright/test';
import { config, daysUntilExpiry, landingIssue, ownedSites, siteFor } from '../core/config.mjs';
import { apiSite, jiraConfig } from '../core/credentials.mjs';
import { laneProject, lanes } from '../core/lanes.mjs';
import { isMarker, markers } from '../core/markers.mjs';
import { retryRead, safeRequest } from '../core/safe-request.mjs';
import { activeTarget, browserTarget } from '../core/target.mjs';
import { client, projects, tokenRequest } from './client.mjs';
import { validateIdentityFixture } from './identity.mjs';
import { openRun } from './run.mjs';
import { sitePreflight } from './site-preflight.mjs';
import { heldFor, leaseUses, siteLease } from './site-lease.mjs';
import { runSuite } from '../core/suite.mjs';

// Implementations of the forge-test commands (bin/forge-test.mjs). Each refuses anything but an
// owned site and never prints credentials, cookies or response bodies.

/**
 * Runs a suite while holding the site lease, so suites from other repositories or machines on
 * the same site wait (or, with `uses`, only those that conflict with it). The lease is renewed on a timer and confirmed again right before each
 * step; a failed renewal retries on the next tick, and a lost lease stops the suite before its
 * next step or cleanup. FORGE_TEST_LEASE_PRIORITY=1 (a release or landing run) goes ahead of
 * other waiters; any other suite gives the site to a waiting priority run between steps, waits
 * up to `resumeWithin` for it to finish, and continues after its prerequisites run again. A
 * stopped suite (SIGINT, SIGTERM, SIGHUP) ends after its current step and releases the lease; a
 * second signal releases it at once (`stopOnSignal`).
 */
export async function suite(
  title,
  steps,
  { renewEvery = 5 * 60_000, resumeWithin = 120 * 60_000, uses } = {},
) {
  checkSessions(activeTarget().authDirectory);
  const lease = siteLease(client(await tokenRequest()), {
    holder: leaseHolder('suite'),
    priority: process.env.FORGE_TEST_LEASE_PRIORITY === '1',
    uses,
  });
  await lease.acquire();
  let lost;
  let renewing;
  const renew = () =>
    (renewing = lease.renew().catch((error) => {
      if (error.leaseLost) lost = error;
    }));
  const timer = setInterval(renew, renewEvery);
  const signals = stopOnSignal(async () => {
    clearInterval(timer);
    await renewing;
    await lease.release();
  });
  try {
    return await runSuite(title, steps, {
      // Its lanes run under this lease instead of waiting for it.
      env: { ...process.env, FORGE_TEST_LEASE: lease.id },
      before: async () => {
        if (signals.stopped()) throw Error(`the run was stopped (${signals.stopped()})`);
        await renew();
        if (lost) throw lost;
      },
      pause: async () => {
        const first = await lease.priorityWaiting();
        if (!first) return false;
        console.log(
          `\nPausing for ${first}, which goes first on this site; this suite resumes after it.`,
        );
        await renewing;
        await lease.release();
        await lease.acquire({ wait: resumeWithin });
        return true;
      },
      fixturesClean: () => fixturesClean(),
      receipt: suiteReceipt(title),
    });
  } finally {
    signals.dispose();
    clearInterval(timer);
    // A renewal still in flight must settle before release, so it cannot recreate the lease.
    await renewing;
    await lease
      .release()
      .catch(() => console.error('Could not release the site lease; it expires on its own.'));
  }
}

const signalCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/**
 * Keeps a held site lease from outliving a stopped run, where it would block the site until it
 * lapses. The first SIGINT, SIGTERM or SIGHUP only marks the run stopped: the step or Playwright
 * process gets the same signal from the terminal or the CI runner, and the run ends after it and
 * releases the lease as usual. A second signal (a CI runner sends SIGTERM a few seconds after
 * SIGINT) calls `release` at once and exits with that signal's code. `dispose` removes the
 * handlers.
 */
export function stopOnSignal(
  release,
  { on = process, exit = (code) => process.exit(code), log = console.error } = {},
) {
  let stopped = null;
  let releasing;
  const handler = (signal) => {
    if (!stopped) {
      stopped = signal;
      log(
        `${signal}: stopping after the current step, then releasing the site lease (another signal releases it now).`,
      );
      return;
    }
    releasing ??= Promise.resolve()
      .then(release)
      .catch(() => log('Could not release the site lease; it expires on its own.'))
      .finally(() => exit(signalCodes[signal]));
  };
  for (const signal of Object.keys(signalCodes)) on.on(signal, handler);
  return {
    stopped: () => stopped,
    dispose: () => {
      for (const signal of Object.keys(signalCodes)) on.off(signal, handler);
    },
  };
}

const holderLabel = /^[\w .,:#/@()+-]{1,80}$/;

/**
 * The public label a run writes into the site lease, for the logs of runs that wait for it: the
 * GitHub repository and run, else FORGE_TEST_LEASE_HOLDER (a name for this machine or session,
 * never a host or account), else "a local suite" or "a local lane".
 */
export function leaseHolder(kind, env = process.env) {
  const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: run, FORGE_TEST_LEASE_HOLDER: label } = env;
  if (repository) return `${repository} run ${run}`;
  if (!label) return `a local ${kind}`;
  if (!holderLabel.test(label))
    throw Error(
      'FORGE_TEST_LEASE_HOLDER is up to 80 letters, digits, spaces and . , : # / @ ( ) + -.',
    );
  return `${label} (${kind})`;
}

/** Where a suite run's receipt goes: the site's private state, one file per run. */
export const suiteReceipt = (title, at = new Date(), directory = activeTarget().directory) =>
  `${directory}/suites/${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}-${at.toISOString().replaceAll(':', '-')}-${process.pid}.json`;

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
  // Read-only, so a GET that fails on transport or with HTTP 502, 503 or 504 runs once more.
  const get = (path) =>
    retryRead(
      async () => {
        const response = await safeRequest(
          () =>
            fetch(`https://${cfg.site}/rest/api/3${path}`, {
              headers: {
                Authorization: `Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64')}`,
                Accept: 'application/json',
              },
              redirect: 'error',
              signal: AbortSignal.timeout(20000),
            }),
          'GET fetch',
        );
        const body = response.ok
          ? await safeRequest(() => response.json(), 'GET HTTP 200 body read')
          : null;
        return { status: response.status, body };
      },
      { label: 'Jira GET', status: (r) => r.status },
    );
  const { status, body: user } = await get('/myself');
  if (status !== 200)
    throw Error(`Jira authentication probe: HTTP ${status}. Check token expiry, email and scopes.`);
  if (!user.accountId || !user.active) throw Error('Jira did not return an active account.');
  console.log('Jira authentication OK; active account verified.');
  const permissions = await get('/mypermissions?permissions=ADMINISTER');
  if (permissions.status !== 200) throw Error(`Permission probe: HTTP ${permissions.status}`);
  const admin = permissions.body.permissions?.ADMINISTER;
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
  if (apiSite() !== target.host) throw Error('Browser/API site mismatch.');
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
    // Signed in once the landing work item shows its app actions, or Jira returns the signed-in
    // user (an account without access to the landing work item still gets a usable session).
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
 * Creates once, or verifies, each configured fixture app's marked company-managed space and
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
          throw Error(`Unresolved space creation ${key}; inspect before retry`);
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
        throw Error(`Space ownership mismatch ${key}`);
      const roles = await api(`/project/${project.id}/role`);
      const roleId = roles.Administrators?.match(/\/role\/(\d+)$/)?.[1];
      if (!roleId) throw Error('Expected fixture administrator role missing');
      let role = await api(`/project/${project.id}/role/${roleId}`);
      if (!role.actors.some((a) => a.actorUser?.accountId === user.accountId)) {
        const old = existsSync(journal) ? JSON.parse(readFileSync(journal)) : {};
        if (old.roleAttempt) throw Error('Unresolved space-role assignment; inspect before retry');
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
      console.log(`${app}: owned fixture space verified`);
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
 * Holds the site for a lane and resolves a function that releases it. A suite's own lane
 * (FORGE_TEST_LEASE set) runs under the suite's lease and only checks that no one else holds the
 * site. Any other lane takes the lease itself without waiting, renews it while it runs, and
 * refuses at once when another run holds the site, naming that run and how long it has held it.
 * An interactive caller can do something else and come back, where a waiting lane would hide the
 * conflict; a suite (CI) waits instead.
 */
export async function laneLease(
  env,
  {
    api,
    renewEvery = 5 * 60_000,
    lease = siteLease,
    log = console.error,
    onSignal = stopOnSignal,
    uses,
  } = {},
) {
  const request = api ? null : await tokenRequest();
  const dispose = async () => request?.dispose();
  const busy = (status) =>
    Object.assign(
      Error(
        `The site is in use by ${status.holder}, which has held it for ${heldFor(status.heldMs)}; run the lane when it finishes (forge-test lease shows the holder).`,
      ),
      { siteBusy: true },
    );
  let held;
  try {
    held = lease(api ?? client(request), { holder: leaseHolder('lane', env), uses });
    if (env.FORGE_TEST_LEASE) {
      const status = await held.status(env.FORGE_TEST_LEASE);
      if (status && !status.own) throw busy(status);
      await dispose();
      return async () => {};
    }
    try {
      await held.acquire({ wait: 0 });
    } catch (error) {
      // A free site reserved for a priority run keeps the acquire's own message.
      const status = error.siteBusy ? await held.status() : null;
      throw status ? busy(status) : error;
    }
  } catch (error) {
    await dispose();
    throw error;
  }
  let renewing;
  let lost = false;
  const timer = setInterval(() => {
    renewing = held.renew().catch((error) => {
      if (error.leaseLost && !lost) {
        lost = true;
        log('The site lease was lost while the lane ran; another run may now share the site.');
      }
    });
  }, renewEvery);
  const stop = async () => {
    clearInterval(timer);
    // A renewal still in flight must settle before release, so it cannot recreate the lease.
    await renewing;
    await held.release();
  };
  // Playwright gets a stop signal too and ends the lane, which then releases as below.
  const signals = onSignal(stop, { log });
  return async () => {
    signals.dispose();
    await stop().catch(() => log('Could not release the site lease; it expires on its own.'));
    await dispose();
  };
}

const exitCode = (command, args, options) =>
  new Promise((done) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' });
    child.on('error', () => done(1));
    child.on('close', (code) => done(code ?? 1));
  });

/**
 * Runs one browser lane with the consumer's Playwright configuration. The lane's opt-ins, the
 * site's expiry, the saved sessions and the site lease are checked first, so a refusal happens
 * before Playwright starts. A lane holds the site lease while it runs (`laneLease`), since its
 * fixtures share the spaces of every other run on the site.
 */
export async function lane(
  name,
  extra = [],
  {
    configFile = 'playwright.config.mjs',
    uses,
    hold = (env) => laneLease(env, { uses }),
    run = (args, env) => exitCode(process.execPath, args, { env }),
  } = {},
) {
  if (!Object.hasOwn(lanes, name ?? ''))
    throw Error(`Usage: forge-test lane <${Object.keys(lanes).join('|')}> [-- Playwright args]`);
  const env = { ...process.env, E2E_LANE: name };
  // A lane that shares the site tells its journeys, so ones that change account-wide state refuse.
  if (uses) env.FORGE_TEST_LEASE_USES = leaseUses(uses).join(',');
  laneProject(name, env);
  const host = env.PLUGIN_TEST_SITE || env.JIRA_SITE || siteFor('primary');
  const days = daysUntilExpiry(host);
  if (days !== null && days < 0) throw Error(`The site under test expired ${-days} day(s) ago.`);
  if (days !== null && days <= 30)
    console.warn(`WARNING: the site under test expires in ${days} day(s).`);
  checkSessions(browserTarget(host).authDirectory, { env });
  const cli = createRequire(resolve('package.json')).resolve('@playwright/test/cli');
  const release = await hold(env);
  try {
    return await run([cli, 'test', '-c', configFile, `--project=${name}`, ...extra], env);
  } finally {
    await release();
  }
}

/**
 * Read-only: the site lease on the site under test, as `siteLease(api).status()` reports it, or
 * null when the site is free. Writes nothing, so it is safe while any run holds the site.
 */
export async function leaseStatus({ api } = {}) {
  const request = api ? null : await tokenRequest();
  try {
    return await siteLease(api ?? client(request)).status();
  } finally {
    await request?.dispose();
  }
}

/** The `forge-test lease` lines (or JSON) for a status from `leaseStatus`. */
export function leaseReport(status, { json = false, now = Date.now() } = {}) {
  // A status from an earlier version names one holder of the whole site.
  const holders = status ? (status.holders ?? [{ ...status, uses: null }]) : [];
  const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());
  if (json)
    return JSON.stringify(
      status
        ? {
            held: true,
            holder: status.holder,
            since: iso(status.since),
            heldMinutes: status.heldMs === null ? null : Math.floor(status.heldMs / 60_000),
            expires: iso(status.expires),
            priorityWaiting: status.priorityWaiting,
            holders: holders.map((value) => ({
              holder: value.holder,
              uses: value.uses,
              since: iso(value.since),
              expires: iso(value.expires),
            })),
          }
        : { held: false },
    );
  if (!status) return 'The site lease is free.';
  const line = (value) =>
    `${value.holder}${value.uses ? ` (sharing: ${value.uses.join(', ')})` : ''}, for ${heldFor(value.since === null ? null : now - value.since)}; it lapses in ${heldFor(value.expires - now)} unless renewed.`;
  return [
    holders.length === 1
      ? `The site lease is held by ${line(holders[0])}`
      : `The site is shared by ${holders.length} runs:\n${holders.map((value) => `- ${line(value)}`).join('\n')}`,
    ...(status.priorityWaiting ? [`${status.priorityWaiting} is waiting to go first.`] : []),
  ].join('\n');
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
  return { value, expires: sessionExpiry(state) };
}

/** When a saved session's Atlassian sign-in lapses, or null when it records no expiry. */
function sessionExpiry(state) {
  const expiries = (state.cookies ?? [])
    .filter(
      (c) => ['cloud.session.token', 'tenant.session.token'].includes(c.name) && c.expires > 0,
    )
    .map((c) => c.expires * 1000);
  return expiries.length ? new Date(Math.min(...expiries)) : null;
}

const renewWithin = 7; // days
const day = (date) => date.toISOString().slice(0, 10);

/**
 * Checks every saved session in `directory` before a run signs in with them, so a lapsed sign-in
 * never shows up as a failing test: an expired session refuses the run, and one expiring within a
 * week warns (as an annotation on a GitHub runner, so it shows on the run's summary). Prints
 * profile names and dates only. Returns each profile's expiry.
 */
export function checkSessions(
  directory,
  { now = new Date(), env = process.env, warn = console.warn } = {},
) {
  if (!existsSync(directory)) return [];
  const sessions = readdirSync(directory)
    .filter((name) => /^[\w-]+\.json$/.test(name))
    .sort()
    .map((name) => {
      let expires = null;
      try {
        expires = sessionExpiry(JSON.parse(readFileSync(`${directory}/${name}`, 'utf8')));
      } catch {
        // An unreadable file is reported by the browser that loads it.
      }
      return { profile: name.slice(0, -'.json'.length), expires };
    });
  const ci = !!env.GITHUB_ACTIONS;
  const onKeeper = (command) =>
    ci
      ? `run ${command} on the machine that keeps the sessions, then forge-test secrets`
      : `run ${command}`;
  const expired = sessions.filter((s) => s.expires && s.expires <= now);
  if (expired.length)
    throw Error(
      expired
        .map(
          (s) =>
            `The saved ${s.profile} session expired on ${day(s.expires)}; ${onKeeper(`forge-test login ${s.profile}`)}.`,
        )
        .join('\n'),
    );
  for (const { profile, expires } of sessions) {
    const days = expires && Math.floor((expires - now) / 86_400_000);
    if (expires && days < renewWithin) {
      const message = `The saved ${profile} session expires in ${days} day(s), on ${day(expires)}; ${onKeeper(`forge-test renew ${profile}`)}.`;
      warn(ci ? `::warning title=Saved session expiring::${message}` : `WARNING: ${message}`);
    }
  }
  return sessions;
}

/**
 * Whether a renewal may replace a saved session: the account is still signed in and its sign-in
 * now lasts longer than before. Anything else keeps the saved file as it is. Atlassian extends the
 * account's sign-in only so often, so a session renewed shortly before may not be extended again:
 * that is `current` while it still has more than a week, and a failure after that.
 */
export function renewalOutcome(before, after, signedIn, now = new Date()) {
  if (!signedIn) return { replace: false, reason: 'is no longer signed in' };
  if (!after) return { replace: false, reason: 'has no dated sign-in after renewal' };
  if (before && after <= before)
    return before - now > renewWithin * 86_400_000
      ? { replace: false, current: true }
      : { replace: false, reason: 'was not extended' };
  return { replace: true };
}

/**
 * Renews saved sessions without a sign-in: Atlassian extends a session's sign-in cookies (about 30
 * days) when it is used, on the site and on id.atlassian.com. Each session opens the landing work
 * item and the Atlassian account page in headless Chrome, and is saved again only when Jira still
 * returns its account and the sign-in lasts longer than before. An expired session needs `login`.
 * Prints profile names and dates only. Returns whether every requested session was renewed or is
 * current.
 */
export async function renew(profiles = [], { now = new Date(), settle = 20_000 } = {}) {
  for (const profile of profiles)
    if (!profileName.test(profile)) throw Error('Use a lowercase profile name, such as admin.');
  const target = activeTarget();
  if (apiSite() !== target.host) throw Error('Browser/API site mismatch.');
  // Each session's expiry, without refusing or warning: renew reports every one itself.
  const saved = checkSessions(target.authDirectory, { now: new Date(0), warn: () => {} });
  const chosen = profiles.length
    ? profiles.map((profile) => {
        const found = saved.find((s) => s.profile === profile);
        if (!found) throw Error(`Missing ${profile} session; run forge-test login ${profile}.`);
        return found;
      })
    : saved.filter((s) => s.expires);
  if (!chosen.length) throw Error('No saved sessions to renew; run forge-test login first.');
  let failed = 0;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const { profile, expires: before } of chosen) {
      if (before && before <= now) {
        console.log(`${profile}: expired on ${day(before)}; run forge-test login ${profile}.`);
        failed++;
        continue;
      }
      const path = `${target.authDirectory}/${profile}.json`;
      const context = await browser.newContext({ storageState: path });
      try {
        const page = await context.newPage();
        await page.goto(`${target.site}/browse/${landingIssue()}`, {
          waitUntil: 'domcontentloaded',
        });
        const me = await context.request
          .get(`${target.site}/rest/api/3/myself`, { maxRedirects: 0 })
          .catch(() => null);
        const signedIn = !!(me?.ok() && (await me.json().catch(() => null))?.accountId);
        if (signedIn)
          await page.goto('https://id.atlassian.com/manage-profile', {
            waitUntil: 'domcontentloaded',
          });
        let after = sessionExpiry({ cookies: await context.cookies() });
        for (const deadline = Date.now() + settle; signedIn && Date.now() < deadline;) {
          if (after && (!before || after > before)) break;
          await page.waitForTimeout(1000);
          after = sessionExpiry({ cookies: await context.cookies() });
        }
        const outcome = renewalOutcome(before, after, signedIn, now);
        if (outcome.current) {
          console.log(`${profile}: current, signed in until ${day(before)}.`);
          continue;
        }
        if (!outcome.replace) {
          console.log(`${profile}: ${outcome.reason}; kept the saved session.`);
          failed++;
          continue;
        }
        const next = `${path}.renewing`;
        await context.storageState({ path: next, indexedDB: true });
        chmodSync(next, 0o600);
        renameSync(next, path);
        console.log(`${profile}: renewed, signed in until ${day(after)}.`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return failed === 0;
}

/** Which saved session is whose: an account ID shortened to its last four characters. */
const shortAccount = (id) => `…${String(id).slice(-4)}`;

/** The pinned identity accounts on the site under test (owner, member, restricted), or null. */
function identityPins(target) {
  try {
    const value = JSON.parse(readFileSync(`${target.directory}/identity-fixture.json`, 'utf8'));
    return validateIdentityFixture(value, target.host).actors;
  } catch {
    return null;
  }
}

/**
 * The account a saved session signs in as, from Jira's /myself through that session (no browser,
 * no redirects), or null when Jira returns none (signed out). A dropped connection is retried once.
 */
async function sessionAccount(file, site) {
  const context = await playwrightRequest.newContext({ storageState: file });
  try {
    return await retryRead(
      async () => {
        const response = await safeRequest(
          () =>
            context.get(`${site}/rest/api/3/myself`, {
              maxRedirects: 0,
              timeout: 20_000,
              headers: { Accept: 'application/json' },
            }),
          'GET fetch',
        );
        if (!response.ok()) return { status: response.status(), accountId: null };
        const body = await safeRequest(() => response.json(), 'GET body read').catch(() => null);
        return { status: response.status(), accountId: body?.accountId ?? null };
      },
      { label: 'Jira GET', status: (r) => r.status },
    ).then(({ status, accountId }) => {
      // 401 or 403, or a redirect to the sign-in page: signed out. Anything else is no answer.
      if (status === 200 || status === 401 || status === 403 || (status >= 300 && status < 400))
        return accountId;
      throw Error(`Jira answered HTTP ${status}`);
    });
  } finally {
    await context.dispose();
  }
}

/**
 * Read-only report of the saved sessions on the site under test (or the named profiles): when
 * each was saved and when its sign-in lapses. With `verify`, it also asks Jira who each unexpired
 * session is and compares the account with the identity pins: `pin` names the pinned role it
 * matches (owner, member or restricted) or is null, and `sameAs` lists the other reported profiles
 * with the same account. Accounts appear only shortened (`…abcd`); nothing else from Jira is kept.
 * `ask(file, site)` resolves the account ID for a session file, or null when signed out.
 */
export async function sessionReport(
  profiles = [],
  { verify = false, target = activeTarget(), now = new Date(), ask = sessionAccount } = {},
) {
  for (const profile of profiles)
    if (!profileName.test(profile)) throw Error('Use a lowercase profile name, such as admin.');
  const saved = checkSessions(target.authDirectory, { now: new Date(0), warn: () => {} });
  const names = profiles.length ? profiles : saved.map((s) => s.profile);
  const sessions = names.map((profile) => {
    const file = `${target.authDirectory}/${profile}.json`;
    if (!existsSync(file)) return { profile, missing: true };
    const { expires } = saved.find((s) => s.profile === profile) ?? { expires: null };
    return {
      profile,
      saved: statSync(file).mtime.toISOString(),
      expires: expires?.toISOString() ?? null,
      expired: !!(expires && expires <= now),
    };
  });
  if (!verify) return { verified: false, sessions };
  const pins = identityPins(target);
  const accounts = new Map();
  for (const session of sessions) {
    if (session.missing || session.expired) continue;
    try {
      accounts.set(
        session.profile,
        await ask(`${target.authDirectory}/${session.profile}.json`, target.site),
      );
    } catch (error) {
      session.verify = { error: error.message };
    }
  }
  for (const session of sessions) {
    if (!accounts.has(session.profile)) continue;
    const account = accounts.get(session.profile);
    session.verify = account
      ? {
          signedIn: true,
          account: shortAccount(account),
          pin: Object.entries(pins ?? {}).find(([, id]) => id === account)?.[0] ?? null,
          sameAs: [...accounts]
            .filter(([other, id]) => other !== session.profile && id === account)
            .map(([other]) => other),
        }
      : { signedIn: false };
  }
  return { verified: true, pins: !!pins, sessions };
}

/** The `forge-test sessions` lines for a `sessionReport`. */
export function sessionLines({ verified, pins, sessions }) {
  const lines = sessions.map((s) => {
    if (s.missing) return `${s.profile}: missing; run forge-test login ${s.profile}.`;
    const dates = `${s.expired ? 'expired' : 'signed in until'} ${s.expires ? day(new Date(s.expires)) : 'an undated time'}, saved ${day(new Date(s.saved))}`;
    if (!s.verify) return `${s.profile}: ${dates}.`;
    if (s.verify.error) return `${s.profile}: ${dates}; not verified (${s.verify.error}).`;
    if (!s.verify.signedIn) return `${s.profile}: ${dates}; Jira returned no account (signed out).`;
    const who = s.verify.pin ? `the pinned ${s.verify.pin} account` : 'an unpinned account';
    const same = s.verify.sameAs.length ? `; same account as ${s.verify.sameAs.join(', ')}` : '';
    return `${s.profile}: ${dates}; signed in as ${who} (${s.verify.account})${same}.`;
  });
  if (verified && !pins) lines.push('No identity pins for this site; accounts were not compared.');
  return lines;
}

/**
 * Copies this configuration, the API credentials, saved sessions and the identity pins into a
 * GitHub Actions environment's secrets through `gh secret set` (values on stdin). Prints names,
 * sizes and session expiry dates only. `sessionsOnly` sets just the sessions, as after `renew`,
 * leaving the configuration, credentials and identity pins as they are.
 */
export function secrets({ repo, environment, profiles, dryRun, sessionsOnly = false }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !profileName.test(environment ?? ''))
    throw Error(
      'Usage: forge-test secrets --repo <owner/name> --env <environment> [--sessions-only] [--dry-run]',
    );
  const target = browserTarget(siteFor('primary'));
  const list = [];
  if (!sessionsOnly) {
    const { email, token } = jiraConfig();
    list.push(
      { name: 'FORGE_TEST_CONFIG', value: JSON.stringify({ ...config(), state: undefined }) },
      { name: 'ATLASSIAN_EMAIL', value: email },
      { name: 'ATLASSIAN_API_TOKEN', value: token },
    );
  }
  for (const profile of profiles) {
    if (!profileName.test(profile)) throw Error('Invalid profile name.');
    const file = `${target.authDirectory}/${profile}.json`;
    if (!existsSync(file))
      throw Error(`Missing ${profile} session; run forge-test login ${profile}.`);
    const { value, expires } = sessionSecret(file);
    if (expires && expires <= new Date())
      throw Error(
        `The saved ${profile} session expired on ${day(expires)}; run forge-test login ${profile}.`,
      );
    list.push({
      name: secretName(profile),
      value,
      note: expires ? `session expires ${expires.toISOString().slice(0, 10)}` : 'no expiry found',
    });
  }
  const identity = `${target.directory}/identity-fixture.json`;
  if (!sessionsOnly && existsSync(identity))
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
  checkSessions(target.authDirectory, { env });
}

/**
 * Values a public CI log must never show: owned hosts, environment IDs, pinned account IDs and
 * the fixture space keys (which also hides every work item key in those spaces). The workflow
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
  // characters. Space keys are short by nature and are masked from three.
  return [
    ...new Set([
      ...values.filter((v) => typeof v === 'string' && v.length >= 6),
      ...keys.filter((k) => typeof k === 'string' && k.length >= 3),
    ]),
  ];
}
