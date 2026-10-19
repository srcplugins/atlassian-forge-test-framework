import { request as playwrightRequest } from '@playwright/test';
import { fixtureApps, ownedSites } from '../core/config.mjs';
import { jiraConfig } from '../core/credentials.mjs';
import { safeRequest } from '../core/safe-request.mjs';
import { activeTarget } from '../core/target.mjs';

/** The Jira site under test, https://<host>. */
export const site = () => activeTarget().site;
/** Disposable fixture spaces by fixture app (configuration fixtures.apps). */
export const projects = () => fixtureApps();

/**
 * A Jira REST v3 client bound to an owned site. GET 404 is null; other failures throw without
 * response details, marking definitive rejections. Writes never retry. A peer site is read-only.
 */
export function client(request, targetSite = site()) {
  if (!ownedSites().some((host) => targetSite === `https://${host}`))
    throw Error('Owned Jira API site required');
  return async (path, method = 'GET', data) => {
    if (targetSite !== site() && method !== 'GET') throw Error('Peer tenant API is read-only');
    if (!path.startsWith('/') || path.includes('://') || path.includes('..'))
      throw Error('Invalid Jira path');
    const response = await safeRequest(
      () =>
        request.fetch(`${targetSite}/rest/api/3${path}`, {
          method,
          ...(data === undefined ? {} : { data }),
          timeout: 30000,
          maxRedirects: 0,
        }),
      `${method} fetch`,
    );
    if (method === 'GET' && response.status() === 404) return null;
    if (!response.ok()) {
      const error = new Error(
        `Fixture API ${method} failed (HTTP ${response.status()}); no automatic write retry.`,
      );
      // Jira refuses a rate-limited (429) request before processing it, so it changed nothing.
      error.definitiveRejection = [400, 401, 403, 422, 429].includes(response.status());
      throw error;
    }
    if (response.status() === 204) return null;
    // Work item property creation returns 201 with an empty body.
    const stage = `${method} HTTP ${response.status()}`;
    const text = await safeRequest(() => response.text(), `${stage} body read`);
    return text ? safeRequest(() => JSON.parse(text), `${stage} JSON parse`) : null;
  };
}
export async function allIssues(api, projectId) {
  let token;
  const seen = new Set();
  const out = [];
  for (let i = 0; i < 20; i++) {
    const r = await api(
      `/search/jql?jql=${encodeURIComponent(`project = ${projectId} ORDER BY id ASC`)}&fields=summary,labels,description,project&maxResults=100${token ? `&nextPageToken=${encodeURIComponent(token)}` : ''}`,
    );
    if (!Array.isArray(r?.issues)) throw Error('Invalid work item search');
    out.push(...r.issues);
    if (r.isLast) return out;
    if (!r.nextPageToken || seen.has(r.nextPageToken)) throw Error('Invalid cursor');
    token = r.nextPageToken;
    seen.add(token);
  }
  throw Error('Fixture search limit exceeded');
}
export async function comments(api, id) {
  let start = 0;
  const out = [];
  for (let i = 0; i < 20; i++) {
    const r = await api(`/issue/${id}/comment?startAt=${start}&maxResults=100`);
    if (!Array.isArray(r?.comments)) throw Error('Invalid comments');
    out.push(...r.comments);
    start += r.comments.length;
    if (start === r.total) return out;
    if (!r.comments.length || start > r.total) throw Error('Invalid comment pagination');
  }
  throw Error('Comment limit');
}

/** An API request context authenticated with the configured account, for the site under test. */
export async function tokenRequest() {
  const c = jiraConfig();
  if (`https://${c.site}` !== site() || !c.email || !c.token)
    throw Error('Owned Jira API credentials required');
  return playwrightRequest.newContext({
    extraHTTPHeaders: {
      Authorization: `Basic ${Buffer.from(`${c.email}:${c.token}`).toString('base64')}`,
      Accept: 'application/json',
    },
  });
}
