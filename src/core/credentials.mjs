import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { config, ownedSites, siteFor, stateRoot } from './config.mjs';

// Atlassian account credentials for connected tooling (Jira REST and the Forge CLI): the
// environment first, then optionally the macOS Keychain item named by the configuration's
// keychainService. Values are never logged or written anywhere.
function keychainToken(service) {
  if (!service || process.platform !== 'darwin') return undefined;
  const result = spawnSync('security', ['find-generic-password', '-s', service, '-w'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
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

export function atlassianCredentials(env = process.env) {
  const email = env.JIRA_EMAIL || config().email || localEmail();
  const token = env.JIRA_API_KEY || keychainToken(config().keychainService);
  return {
    email,
    token,
    forgeEmail: env.FORGE_EMAIL || email,
    forgeToken: env.FORGE_API_TOKEN || token,
  };
}

/** The selected API site (JIRA_SITE or the primary role) with credentials. */
export function jiraConfig(env = process.env) {
  return { site: apiSite(env), ...atlassianCredentials(env) };
}

/** The selected API site: JIRA_SITE or the primary role, always an owned site. */
export function apiSite(env = process.env) {
  const site = env.JIRA_SITE || siteFor('primary');
  if (!ownedSites().includes(site)) throw Error('JIRA_SITE must be an owned site.');
  return site;
}
