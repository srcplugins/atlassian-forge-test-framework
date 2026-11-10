import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { config, ownedSites, siteFor, stateRoot } from './config.mjs';

// Atlassian account credentials for connected tooling (Jira REST and the Forge CLI): the
// environment first, then optionally the keyring item named by the configuration's
// keychainService: the macOS Keychain, or the Secret Service on Linux (libsecret's secret-tool).
// A missing tool or item gives no token, never an error. Values are never logged or written.
const keyringLookups = {
  darwin: (service) => ['security', ['find-generic-password', '-s', service, '-w']],
  linux: (service) => ['secret-tool', ['lookup', 'service', service]],
};
function keychainToken(service) {
  const lookup = keyringLookups[process.platform];
  if (!service || !lookup) return undefined;
  const [command, args] = lookup(service);
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
  });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

// A host repository may keep its non-secret account email in <state>/config.json.
function localEmail() {
  try {
    return JSON.parse(readFileSync(`${stateRoot()}/config.json`, 'utf8')).email;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

// ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN name the one account for every product and for the
// Forge CLI; no other variable is read. The configuration and the keyring are where a machine
// stores the same two values.
export function atlassianCredentials(env = process.env) {
  return {
    email: env.ATLASSIAN_EMAIL || config().email || localEmail(),
    token: env.ATLASSIAN_API_TOKEN || keychainToken(config().keychainService),
  };
}

/** The account's credentials, or an error naming each variable that is missing. */
export function requireCredentials(env = process.env) {
  const credentials = atlassianCredentials(env);
  const missing = [
    !credentials.email && 'ATLASSIAN_EMAIL',
    !credentials.token && 'ATLASSIAN_API_TOKEN',
  ].filter(Boolean);
  if (missing.length) throw Error(`Set ${missing.join(' and ')}.`);
  return credentials;
}

/** The selected API site (JIRA_SITE or the primary role) with credentials. */
export function jiraConfig(env = process.env) {
  return { site: apiSite(env), ...requireCredentials(env) };
}

/** The selected API site: JIRA_SITE or the primary role, always an owned site. */
export function apiSite(env = process.env) {
  const site = env.JIRA_SITE || siteFor('primary');
  if (!ownedSites().includes(site)) throw Error('JIRA_SITE must be an owned site.');
  return site;
}
