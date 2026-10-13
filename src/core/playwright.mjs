import { test as base, expect } from '@playwright/test';
import { activeTarget } from './target.mjs';

// Chrome requires explicit site permission for Jira to load Forge's localhost UI.
// Grant it only in opt-in tunnel runs and only to the owned site under test.
export const test = base.extend({
  tunnelPermission: [
    async ({ context }, use) => {
      if (process.env.FORGE_TUNNEL === '1') {
        await context.grantPermissions(['local-network-access'], {
          origin: activeTarget().site,
        });
      }
      await use();
    },
    { auto: true },
  ],
});
export { expect };
