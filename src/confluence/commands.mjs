// Confluence variants of the CLI commands whose Jira versions act on Jira data. The API account
// is the site's Atlassian account (ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN, or the older JIRA_* names).
import { config } from '../core/config.mjs';
import { tokenRequest } from '../jira/client.mjs';
import { confluenceCall, prepareSpace } from './fixtures.mjs';
import { confluenceTarget } from './target.mjs';

/** Read-only check that the API account is a signed-in Confluence user on the site under test. */
export async function doctor() {
  confluenceTarget();
  const context = await tokenRequest();
  try {
    const call = confluenceCall(context);
    const user = await call('/wiki/rest/api/user/current');
    if (user.status !== 200 || user.body?.type !== 'known' || !user.body.accountId)
      throw Error(
        `Confluence authentication probe: HTTP ${user.status}. Check token expiry, email and product access.`,
      );
    console.log('Confluence authentication OK; known account verified.');
    const spaces = await call('/wiki/api/v2/spaces?limit=1');
    if (spaces.status !== 200) throw Error(`Confluence space probe: HTTP ${spaces.status}`);
    console.log('Confluence spaces readable.');
  } finally {
    await context.dispose();
  }
}

/** Creates once, or verifies, each configured app's marked Confluence fixture space. */
export async function prepare() {
  const apps = Object.keys(config().fixtures.confluenceSpaces);
  if (!apps.length) throw Error('No Confluence fixture spaces configured.');
  confluenceTarget();
  const context = await tokenRequest();
  try {
    const call = confluenceCall(context);
    for (const app of apps) {
      await prepareSpace(call, app);
      console.log(`${app}: owned Confluence fixture space verified`);
    }
  } finally {
    await context.dispose();
  }
}
