import { existsSync, readFileSync } from 'node:fs';
import { activeInstallation } from '../core/target.mjs';
import { test as base, expect } from '../core/playwright.mjs';
import { tokenRequest } from '../jira/client.mjs';
import { confluenceCall } from './fixtures.mjs';
import { appReady, defaultAppLoadLimit, guardTest } from '../core/page-guard.mjs';
import { pageGuard } from './guard.mjs';
import { confluenceTarget, spaceSettingsPath } from './target.mjs';

// The app ID in ./manifest.yml, when the tests run from an app's repository.
const manifestAppId = () =>
  existsSync('manifest.yml')
    ? readFileSync('manifest.yml', 'utf8').match(/app\/([0-9a-f-]{36})/)?.[1]
    : undefined;

// Playwright fixtures for Confluence journeys. `pageGuard` watches every test's browser context
// and fails the test on an undeclared Confluence error flag or an app frame that never loads.
// `confluence` is a `confluenceCall` as the configured API account, on the verified site.
export const test = base.extend({
  expectedFlags: [[], { option: true }],
  appLoadLimit: [defaultAppLoadLimit, { option: true }],
  appIds: [undefined, { option: true }],
  pageGuard: [
    async ({ context, expectedFlags, appLoadLimit, appIds }, use, info) => {
      const guard = await pageGuard(context, {
        appIds: appIds ?? [manifestAppId()].filter(Boolean),
        appLoadLimit,
        expectedFlags,
        annotate: (type, description) => info.annotations.push({ type, description }),
      });
      await guardTest(guard, context, use, info);
    },
    { auto: true },
  ],
  confluence: async ({}, use) => {
    confluenceTarget();
    const request = await tokenRequest();
    try {
      await use(confluenceCall(request));
    } finally {
      await request.dispose();
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

/**
 * Opens an app's space settings page (`confluence:spaceSettings` route) in a space and waits until
 * the app is ready (`appReady`). `{ ready: false }` only opens the page, as for a page Confluence
 * should refuse.
 */
export async function spaceSettingsPage(page, app, spaceKey, route, { ready = true } = {}) {
  const t = installation(app);
  await page.goto(
    confluenceTarget().site + spaceSettingsPath(spaceKey, t.appId, t.environmentId, route),
    { waitUntil: 'domcontentloaded' },
  );
  if (ready) await appReady(page, { required: false });
}
