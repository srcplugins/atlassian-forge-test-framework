// Journaled Confluence fixtures: the marked fixture space, disposable pages, labels and page
// restrictions. Pages go through the core FixtureRun (intent before every create, a lost create
// reconciled by its marker title and never repeated, cleanup that rechecks the space and marker
// and confirms the purge with an independent read). Labels and restrictions live on a run's pages
// and go with them; an uncertain label or restriction write is reconciled by reading, never
// repeated.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { confluenceSpaceKey } from '../core/config.mjs';
import { isMarker, isRunMarker, markers } from '../core/markers.mjs';
import { retryRead, safeRequest } from '../core/safe-request.mjs';
import { confluenceTarget } from './target.mjs';

const path = /^\/wiki\/(?:api\/v2|rest\/api)\/[a-zA-Z0-9/_-]+(?:\?[^#\\]*)?$/;
const methods = ['GET', 'POST', 'PUT', 'DELETE'];
const pageStatuses = 'status=current&status=archived&status=trashed&status=draft';

/**
 * One Confluence REST request on the verified Confluence site that keeps the status:
 * `{ status, body }`. A transport failure throws without response details. A write is never
 * retried; a GET that fails on transport or answers 502, 503 or 504 runs once more
 * (`retryRead`). The site is sent as Origin, as Confluence's own pages do, so a saved session's
 * write isn't refused by the XSRF check before its permissions are.
 */
export function confluenceCall(request, host, { retry = {} } = {}) {
  const target = confluenceTarget(host);
  return async (route, method = 'GET', data) => {
    if (
      typeof route !== 'string' ||
      !path.test(route) ||
      route.includes('..') ||
      route.includes('://') ||
      !methods.includes(method)
    )
      throw Error('Invalid Confluence request.');
    const once = async () => {
      const response = await safeRequest(
        () =>
          request.fetch(`${target.site}${route}`, {
            method,
            headers: { Origin: target.site, Accept: 'application/json' },
            ...(data === undefined ? {} : { data }),
            timeout: 30_000,
            maxRedirects: 0,
          }),
        `Confluence ${method} fetch`,
      );
      const text = await safeRequest(() => response.text(), `Confluence ${method} body read`);
      let body;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { status: response.status(), body };
    };
    return method === 'GET'
      ? retryRead(once, { label: 'Confluence GET', status: (r) => r.status, ...retry })
      : once();
  };
}

const ok = (status) => status >= 200 && status < 300;
// Confluence answers these before changing anything; anything else may have landed.
const definite = (status) => [400, 401, 403, 404, 409].includes(status);
function rejection(stage, status) {
  const error = Error(`Confluence ${stage} refused (HTTP ${status}).`);
  error.definitiveRejection = definite(status);
  error.status = status;
  return error;
}

/** The marked fixture space for an app, or null when it doesn't exist. Read-only. */
export async function findSpace(call, app) {
  const key = confluenceSpaceKey(app);
  const { status, body } = await call(
    `/wiki/api/v2/spaces?keys=${key}&description-format=plain&limit=2`,
  );
  if (!ok(status)) throw rejection('space read', status);
  const results = body?.results;
  if (!Array.isArray(results) || results.length > 1) throw Error('Unexpected space listing.');
  const space = results[0];
  if (!space) return null;
  if (
    space.key !== key ||
    !/^[1-9]\d*$/.test(String(space.id)) ||
    !isMarker(space.description?.plain?.value, markers.browserProject(app))
  )
    throw Error(`Space ownership mismatch ${key}`);
  return { id: String(space.id), key };
}

/**
 * Creates once, or verifies, an app's marked Confluence fixture space as the API account. Intent
 * is journaled before the create; an unresolved earlier attempt stops it until it is inspected.
 */
export async function prepareSpace(call, app, host) {
  const key = confluenceSpaceKey(app);
  const journal = `${dirname(confluenceTarget(host).runs)}/space-${key}.json`;
  let space = await findSpace(call, app);
  if (!space) {
    if (existsSync(journal)) throw Error(`Unresolved space creation ${key}; inspect before retry`);
    mkdirSync(dirname(journal), { recursive: true, mode: 0o700 });
    writeFileSync(journal, JSON.stringify({ app, key, status: 'creating' }), {
      flag: 'wx',
      mode: 0o600,
    });
    const { status } = await call('/wiki/rest/api/space', 'POST', {
      key,
      name: markers.browserProjectName(app),
      description: { plain: { value: markers.browserProject(app), representation: 'plain' } },
    });
    if (!ok(status)) throw rejection('space create', status);
    space = await findSpace(call, app);
    if (!space) throw Error(`Space ${key} not found after creation; inspect before retry`);
  }
  writeFileSync(journal, JSON.stringify({ app, key, id: space.id, status: 'verified' }), {
    mode: 0o600,
  });
  return space;
}

/**
 * FixtureRun adapter for disposable pages in the fixture space. A page's title starts with its
 * run marker (`expected.marker`), which is how a lost create is found and ownership rechecked.
 */
export function pageAdapter(call, space, runId) {
  const owned = (expected) =>
    isRunMarker(expected?.marker, runId) &&
    typeof expected.title === 'string' &&
    expected.title.startsWith(`${expected.marker} `);
  const read = async (id) => {
    const { status, body } = await call(`/wiki/api/v2/pages/${id}?${pageStatuses}`);
    if (status === 404) return null;
    if (!ok(status)) throw rejection('page read', status);
    return body;
  };
  const find = async (expected) => {
    if (!owned(expected)) throw Error('Unmarked page fixture.');
    const title = encodeURIComponent(expected.title);
    const { status, body } = await call(
      `/wiki/api/v2/spaces/${space.id}/pages?title=${title}&${pageStatuses}&limit=5`,
    );
    if (!ok(status)) throw rejection('page search', status);
    return (body?.results ?? []).filter((page) => page.title === expected.title);
  };
  return {
    async create(expected) {
      if (!owned(expected)) throw Error('Unmarked page fixture.');
      const { status, body } = await call('/wiki/api/v2/pages', 'POST', {
        spaceId: space.id,
        status: 'current',
        title: expected.title,
        body: { representation: 'storage', value: expected.body ?? '<p>Synthetic data only.</p>' },
      });
      if (!ok(status)) throw rejection('page create', status);
      return { id: body?.id };
    },
    find,
    absent: async (expected) => (await find(expected)).length === 0,
    read,
    async verify(entry, current) {
      const page = current ?? (await read(entry.id));
      if (
        !owned(entry.expected) ||
        page?.title !== entry.expected.title ||
        String(page.spaceId) !== space.id
      )
        throw Error('Page ownership mismatch');
    },
    // Deleting moves a page to the trash; purging removes it, so the run leaves nothing behind.
    async remove(entry) {
      const page = await read(entry.id);
      if (page?.status !== 'trashed') {
        const trashed = await call(`/wiki/api/v2/pages/${entry.id}`, 'DELETE');
        if (!ok(trashed.status)) throw rejection('page delete', trashed.status);
      }
      const purged = await call(`/wiki/api/v2/pages/${entry.id}?purge=true`, 'DELETE');
      if (!ok(purged.status)) throw rejection('page purge', purged.status);
    },
  };
}

const labelName = /^[a-z0-9][a-z0-9_-]{0,99}$/;

/** A page's global label names, read as the caller. */
export async function pageLabels(call, pageId) {
  const { status, body } = await call(`/wiki/api/v2/pages/${pageId}/labels?limit=250`);
  if (!ok(status)) throw rejection('label read', status);
  return (body?.results ?? []).filter((l) => l.prefix === 'global').map((l) => l.name);
}

/**
 * Adds or removes one label as the caller's account. Returns `{ outcome, status }`: `applied`,
 * `rejected` (Confluence refused it before changing anything) or, after a failed or uncertain
 * response, what a read shows (`applied` or `absent`, with `reconciled: true`). Never retried.
 */
export async function changeLabel(call, pageId, action, name) {
  if (!/^[1-9]\d*$/.test(String(pageId)) || !labelName.test(name ?? ''))
    throw Error('Page ID and a lowercase label required.');
  if (!['add', 'remove'].includes(action)) throw Error('Label action must be add or remove.');
  let status;
  try {
    ({ status } =
      action === 'add'
        ? await call(`/wiki/rest/api/content/${pageId}/label`, 'POST', [{ prefix: 'global', name }])
        : await call(`/wiki/rest/api/content/${pageId}/label?name=${name}`, 'DELETE'));
  } catch {
    status = null;
  }
  if (status !== null && ok(status)) return { outcome: 'applied', status };
  if (status !== null && definite(status)) return { outcome: 'rejected', status };
  const present = (await pageLabels(call, pageId)).includes(name);
  return {
    outcome: present === (action === 'add') ? 'applied' : 'absent',
    status,
    reconciled: true,
  };
}

/**
 * Restricts who can view (and edit) a run's page, replacing its user lists. Confluence requires
 * the caller in each list. An uncertain write is reconciled by reading the restrictions back.
 */
export async function restrictPage(call, pageId, { read, update = read }) {
  const users = (ids) => {
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => !/^[\w:-]{1,128}$/.test(id)))
      throw Error('Restriction account IDs required.');
    return { results: ids.map((accountId) => ({ accountId })) };
  };
  const body = {
    results: [
      { operation: 'read', restrictions: { user: users(read) } },
      { operation: 'update', restrictions: { user: users(update) } },
    ],
  };
  let status;
  try {
    ({ status } = await call(`/wiki/rest/api/content/${pageId}/restriction`, 'PUT', body));
  } catch {
    status = null;
  }
  if (status !== null && ok(status)) return { outcome: 'applied', status };
  if (status !== null && definite(status)) return { outcome: 'rejected', status };
  const current = await call(
    `/wiki/rest/api/content/${pageId}/restriction/byOperation/read?expand=restrictions.user`,
  );
  if (!ok(current.status)) throw rejection('restriction read', current.status);
  const ids = new Set((current.body?.restrictions?.user?.results ?? []).map((u) => u.accountId));
  const applied = ids.size === read.length && read.every((id) => ids.has(id));
  return { outcome: applied ? 'applied' : 'absent', status, reconciled: true };
}

/** A FixtureRun journal stored as one private JSON file per run under the Confluence state. */
export function journalFile(runId, host) {
  if (!/^[0-9a-f-]{36}$/.test(runId ?? '')) throw Error('Invalid run ID');
  const file = `${confluenceTarget(host).runs}/${runId}.json`;
  return {
    file,
    save(state) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    },
    load: () => JSON.parse(readFileSync(file, 'utf8')),
  };
}
