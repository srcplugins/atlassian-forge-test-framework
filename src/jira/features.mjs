import { activeEnvironment, activeInstallation, activeTarget } from '../core/target.mjs';
import { test as base, expect } from '../core/playwright.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { openRun } from './run.mjs';
import { site, tokenRequest, client } from './client.mjs';
import { pageGuard } from './guard.mjs';

// The app ID in ./manifest.yml, when the tests run from an app's repository.
const manifestAppId = () =>
  existsSync('manifest.yml')
    ? readFileSync('manifest.yml', 'utf8').match(/app\/([0-9a-f-]{36})/)?.[1]
    : undefined;

// Playwright fixtures for disposable-fixture journeys. A suite selects its fixture app with
// test.use({ fixtureApp }), and a registered profile with test.use({ fixtureProfile }); `owned`
// opens a journaled run and always cleans it up. `pageGuard` watches every test's browser
// context and fails the test on an undeclared Jira error flag or an app frame that never loads.
export const test = base.extend({
  fixtureApp: [undefined, { option: true }],
  fixtureProfile: ['standard', { option: true }],
  expectedFlags: [[], { option: true }],
  appLoadLimit: [15_000, { option: true }],
  appIds: [undefined, { option: true }],
  pageGuard: [
    async ({ context, expectedFlags, appLoadLimit, appIds }, use, info) => {
      const ids = appIds ?? [manifestAppId()].filter(Boolean);
      const guard = await pageGuard(context, {
        appIds: ids,
        appLoadLimit,
        expectedFlags,
        annotate: (type, description) => info.annotations.push({ type, description }),
      });
      await use(guard);
      try {
        guard.check();
      } catch (error) {
        const [page] = context.pages();
        await page?.screenshot({ path: info.outputPath('page-guard.png') }).catch(() => {});
        throw error;
      }
    },
    { auto: true },
  ],
  jiraRequest: async ({}, use) => {
    const request = await tokenRequest();
    try {
      await use(request);
    } finally {
      await request.dispose();
    }
  },
  owned: async (
    { context, page, fixtureApp, fixtureProfile, jiraRequest, pageGuard },
    use,
    info,
  ) => {
    if (!fixtureApp) throw Error('Select the fixture app with test.use({ fixtureApp }).');
    expect((await client(context.request)('/myself')).accountId).toBe(
      (await client(jiraRequest)('/myself')).accountId,
    );
    const owned = await openRun(jiraRequest, fixtureApp, { profile: fixtureProfile });
    owned.run.state.test = info.title;
    owned.run.persist();
    const started = Date.now();
    // A Create form journey waits for Jira's outcome flag, so a flag that comes only after the
    // work item exists (fields saved with exceptions) is seen before the journey moves on.
    const browserIssue = async (...args) => {
      const since = Date.now();
      const issue = await owned.browserIssue(...args);
      await pageGuard.createOutcome({ since });
      return issue;
    };
    try {
      await use({ ...owned, browserIssue });
    } finally {
      owned.run.state.exerciseMs = Date.now() - started;
      owned.run.state.testStatus = info.status;
      owned.run.persist();
      if (info.status !== info.expectedStatus)
        await page
          .screenshot({ path: `${activeTarget().runs}/${owned.run.state.runId}-failure.png` })
          .catch(() => {});
      await owned.cleanup();
    }
  },
});
export { expect };
/**
 * The configured installation of an app on the site and environment under test, with its app ID:
 * the installation's appId, or else the app ID in ./manifest.yml (a plugin repository).
 */
export function installation(app) {
  const target = activeInstallation(app);
  const appId = target.appId ?? manifestAppId();
  if (!appId) throw Error('App ID unavailable: set installation appId or run from the app.');
  return { ...target, appId };
}
export async function projectPage(page, app, key) {
  const t = installation(app);
  await page.goto(`${site()}/jira/software/projects/${key}/apps/${t.appId}/${t.environmentId}`, {
    waitUntil: 'domcontentloaded',
  });
}
export async function panel(page, app, key, label) {
  const t = installation(app);
  await page.goto(`${site()}/browse/${key}`, { waitUntil: 'domcontentloaded' });
  // Jira labels a development installation's panel " DEV"; production has no suffix. Other
  // environments are unverified, so refuse rather than guess.
  const suffix = { development: ' DEV', production: '' }[activeEnvironment()];
  if (suffix === undefined)
    throw Error('Work item panels are verified for development and production only.');
  const title = page.getByRole('heading', { name: `${label}${suffix}`, exact: true });
  if (!(await title.isVisible())) {
    const items = page.getByRole('menuitem', { name: label, exact: true });
    // Jira can paint its button before its menu handler is ready (observed in Firefox).
    // Retry only this read-only menu opening, never a resolver call or posting action.
    await expect(async () => {
      if (!(await items.first().isVisible()))
        await page.getByRole('button', { name: 'View app actions', exact: true }).click();
      await expect(items.first()).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 15000, intervals: [500] });
    const count = await items.count();
    if (count < 1 || count > 3) throw Error('Unexpected app menu inventory');
    for (let i = 0; i < count; i++) {
      if (i) await page.getByRole('button', { name: 'View app actions', exact: true }).click();
      await items.nth(i).click();
    }
  }
  await expect(title).toBeVisible(); // Forge tunnel serves UI Kit's bridge iframe from localhost without an environment ID.
  const tunnel = process.env.FORGE_TUNNEL === '1';
  const source = `contains(@src,"${t.environmentId}")${tunnel ? ' or starts-with(@src,"http://localhost:")' : ''}`;
  const container = title.locator(`xpath=ancestor::div[.//iframe[${source}]][1]`);
  await expect(container.locator('iframe')).toHaveCount(1);
  return container;
}
