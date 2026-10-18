import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Everything site- or account-specific comes from one configuration object, never from code:
// owned sites, Forge installations, fixture space keys and the marker namespace. In CI it is
// the FORGE_TEST_CONFIG secret (JSON); locally a git-ignored .local/forge-test.json, or the file
// named by FORGE_TEST_CONFIG_FILE. Loaded on first use, so a caller may configure() first.
// Schema and examples: docs/configuration.md.

const environments = ['development', 'staging', 'production'];
const host = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/;
const key = /^[A-Z][A-Z0-9_]{1,9}$/;
const slug = /^[a-z][a-z0-9-]*$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fail(message) {
  throw Error(`Invalid forge-test configuration: ${message}`);
}

/** Validates and normalizes a configuration object. Throws without echoing values. */
export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected an object');
  const { namespace, sites, installations = [], fixtures = {} } = value;
  if (!slug.test(namespace ?? '')) fail('namespace must be a lowercase slug');
  const legacy = value.legacyNamespaces ?? [];
  if (
    !Array.isArray(legacy) ||
    legacy.some(
      (l) =>
        !slug.test(l?.slug ?? '') ||
        typeof l.brand !== 'string' ||
        !l.brand ||
        (l.runPrefix != null && !slug.test(l.runPrefix)),
    )
  )
    fail('legacyNamespaces must be [{ slug, brand, runPrefix? }]');
  if (!Array.isArray(sites) || !sites.length) fail('sites must list at least one owned site');
  for (const site of sites) {
    if (!slug.test(site?.role ?? '')) fail('every site needs a role');
    if (!host.test(site.host ?? '')) fail('site hosts must be <name>.atlassian.net');
    if (site.expiresOn != null && Number.isNaN(Date.parse(site.expiresOn)))
      fail('expiresOn must be a date');
  }
  if (new Set(sites.map((s) => s.role)).size !== sites.length) fail('site roles must be unique');
  if (new Set(sites.map((s) => s.host)).size !== sites.length) fail('site hosts must be unique');
  if (!Array.isArray(installations)) fail('installations must be an array');
  for (const i of installations) {
    if (!slug.test(i?.app ?? '')) fail('installation app must be a slug');
    if (!sites.some((s) => s.host === i.site)) fail('installation site must be an owned site');
    if (!environments.includes(i.environment)) fail('unsupported installation environment');
    if (!uuid.test(i.environmentId ?? '')) fail('environmentId must be a UUID');
    if (i.appId != null && !uuid.test(i.appId)) fail('appId must be a UUID');
  }
  const apps = fixtures.apps ?? {};
  const projects = fixtures.projects ?? {};
  for (const [name, projectKey] of Object.entries({ ...apps, ...projects }))
    if (!slug.test(name) || !key.test(projectKey)) fail('fixture spaces map slugs to keys');
  if (fixtures.identity != null && !key.test(fixtures.identity)) fail('identity space key');
  if (fixtures.landing != null && !/^[A-Z][A-Z0-9_]{1,9}-[1-9]\d*$/.test(fixtures.landing))
    fail('landing must be a work item key');
  return structuredClone({
    namespace,
    legacyNamespaces: legacy,
    sites,
    installations,
    fixtures: { apps, projects, identity: fixtures.identity, landing: fixtures.landing },
    state: value.state,
    email: value.email,
    keychainService: value.keychainService,
  });
}

let current;

/** Sets the configuration explicitly (tests, or a host repository's adapter). */
export function configure(value) {
  current = validateConfig(value);
  return current;
}

/** The active configuration, loaded once from FORGE_TEST_CONFIG or a local file. */
export function config() {
  if (current) return current;
  const env = process.env;
  let raw = env.FORGE_TEST_CONFIG;
  if (!raw) {
    const file = resolve(env.FORGE_TEST_CONFIG_FILE ?? '.local/forge-test.json');
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw Error(
        'No forge-test configuration. Set FORGE_TEST_CONFIG or create .local/forge-test.json (docs/configuration.md).',
        { cause: error },
      );
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('not valid JSON'); // The parser's message can quote secret configuration; drop it.
  }
  return configure(parsed);
}

/** Root of private local state (sessions, journals, reports). Never committed. */
export const stateRoot = () => resolve(process.env.FORGE_TEST_STATE ?? config().state ?? '.local');

/** Every owned site host. Connected tooling refuses any other host. */
export const ownedSites = () => config().sites.map((site) => site.host);

/** The owned site with a role, such as 'primary'. */
export function siteFor(role) {
  const site = config().sites.find((entry) => entry.role === role);
  if (!site) throw Error(`No owned site has role ${role}.`);
  return site.host;
}

/** Days until a site's recorded expiry, or null when it has none. */
export function daysUntilExpiry(siteHost, now = new Date()) {
  const expiresOn = config().sites.find((site) => site.host === siteHost)?.expiresOn;
  return expiresOn ? Math.floor((Date.parse(expiresOn) - now.getTime()) / 86_400_000) : null;
}

/** Disposable fixture spaces by fixture app. */
export const fixtureApps = () => ({ ...config().fixtures.apps });

/** A named fixture space key: a fixture app, or another named space such as an isolation one. */
export function fixtureProject(name) {
  const { apps, projects } = config().fixtures;
  const value = apps[name] ?? projects[name];
  if (!value) throw Error(`No fixture space configured for ${name}.`);
  return value;
}

/** The identity fixture space key (pinned owner, member and restricted accounts). */
export function identityProjectKey() {
  const value = config().fixtures.identity;
  if (!value) throw Error('No identity fixture space configured.');
  return value;
}

/** The work item a browser sign-in lands on. */
export function landingIssue() {
  const value = config().fixtures.landing;
  if (!value) throw Error('No landing work item configured.');
  return value;
}

/** Configured Forge installations: { app, site, environment, environmentId, appId? }. */
export const installationTargets = () => config().installations.map((i) => ({ ...i }));
