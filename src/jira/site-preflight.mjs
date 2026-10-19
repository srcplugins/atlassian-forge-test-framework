import { safeRequest } from '../core/safe-request.mjs';
import { ownedSites } from '../core/config.mjs';

// Read-only audit of an owned site. Add a candidate site to the configuration first;
// registration alone does not authorize fixture writes on it.
export async function sitePreflight({ site, email, token, fetchImpl = fetch }) {
  if (!ownedSites().includes(site)) throw Error('Explicitly owned audit site required.');
  if (!email || !token) throw Error('Jira credentials required.');
  const results = {};
  async function get(name, path) {
    const response = await safeRequest(
      () =>
        fetchImpl(`https://${site}/rest/api/3${path}`, {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(20000),
          headers: {
            Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
            Accept: 'application/json',
          },
        }),
      'GET fetch',
    );
    results[name] = { status: response.status };
    return response.ok
      ? safeRequest(() => response.json(), `GET HTTP ${response.status} body read`)
      : null;
  }
  const server = await get('server', '/serverInfo');
  if (server?.baseUrl !== `https://${site}` || server?.deploymentType !== 'Cloud') {
    throw Error('Canonical Jira Cloud site could not be verified; audit stopped.');
  }
  results.server.canonicalSiteVerified = true;
  const actor = await get('authentication', '/myself');
  results.authentication.active = actor?.active === true;
  if (!actor?.accountId || actor.active !== true)
    throw Error('Active Jira identity could not be verified; audit stopped.');
  const permissions = await get(
    'permissions',
    '/mypermissions?permissions=ADMINISTER,CREATE_SHARED_OBJECTS',
  );
  for (const key of ['ADMINISTER', 'CREATE_SHARED_OBJECTS']) {
    results.permissions[key] =
      typeof permissions?.permissions?.[key]?.havePermission === 'boolean'
        ? permissions.permissions[key].havePermission
        : null;
  }
  const roles = await get('applicationRoles', '/applicationrole');
  results.applicationRoles.roles = Array.isArray(roles)
    ? roles
        .filter((x) =>
          ['jira-software', 'jira-servicedesk', 'jira-customer-service'].includes(x.key),
        )
        .map((x) => ({
          key: x.key,
          users: count(x.userCount),
          reportedSeats: count(x.numberOfSeats),
          remainingSeats: count(x.remainingSeats),
        }))
    : null;
  const projects = await get('projects', '/project/search?maxResults=50');
  results.projects.total = count(projects?.total);
  results.projects.sample = Array.isArray(projects?.values)
    ? projects.values.slice(0, 50).map((x) => ({
        id: /^[0-9]+$/.test(x.id) ? x.id : null,
        key: /^[A-Z][A-Z0-9_]*$/.test(x.key) ? x.key : null,
        style: ['classic', 'next-gen'].includes(x.style) ? x.style : null,
      }))
    : null;
  return {
    site,
    checkedAt: new Date().toISOString(),
    results,
    limitations:
      'Read-only connectivity inventory. Seat counts do not prove free entitlement. Rovo, billing, app runtime, separate identities and mutation cleanup require independent acceptance.',
  };
}
function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
