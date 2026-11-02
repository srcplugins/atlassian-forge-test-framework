import { config, siteFor, stateRoot } from '../core/config.mjs';
import { browserTarget } from '../core/target.mjs';

/**
 * Product access is explicit; a Jira-only site record never grants Confluence access. Sessions
 * belong to the site's accounts, so Confluence uses the site's saved sessions; its journals and
 * results are its own.
 */
export function confluenceTarget(host = siteFor('primary')) {
  const site = config().sites.find((s) => s.host === host);
  if (!site?.products?.includes('confluence'))
    throw Error('Verified owned Confluence site required.');
  const base = `${stateRoot()}/products/confluence/sites/${host}`;
  return {
    host,
    site: `https://${host}`,
    authDirectory: browserTarget(host).authDirectory,
    runs: `${base}/e2e/runs`,
    results: (kind) => `${base}/e2e/${kind}`,
  };
}

function spaceKey(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 255 ||
    ['/', '\\', '?', '#'].some((c) => value.includes(c)) ||
    [...value].some((c) => c.charCodeAt(0) <= 32)
  )
    throw Error('Explicit Confluence space key required.');
  return encodeURIComponent(value);
}
function id(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))
    throw Error('Confluence ID required.');
  return value;
}
/** Paths only: callers must navigate on the independently verified Confluence target. */
export const spacePath = (key) => `/wiki/spaces/${spaceKey(key)}`;
export const pagePath = (key, pageId) => `${spacePath(key)}/pages/${id(pageId)}`;
export function spaceSettingsPath(key, appId, environmentId, route) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!uuid.test(appId) || !uuid.test(environmentId) || !/^[a-z0-9-]+$/.test(route))
    throw Error('Confluence installation and route required.');
  return `${spacePath(key)}/settings/apps/${appId}/${environmentId}/${route}`;
}
