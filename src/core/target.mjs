import { ownedSites, siteFor, stateRoot, installationTargets } from './config.mjs';

const environments = ['development', 'staging', 'production'];

/** Private state paths for one owned site: sessions, run journals and results. */
export function browserTarget(host = siteFor('primary')) {
  if (!ownedSites().includes(host)) throw Error('Owned browser test site required.');
  const base = `${stateRoot()}/sites/${host}`;
  const directory = `${base}/e2e`;
  const authDirectory = `${base}/browser-auth`;
  return {
    host,
    site: `https://${host}`,
    directory,
    runs: `${directory}/runs`,
    authDirectory,
    auth: `${authDirectory}/admin.json`,
    results: (kind) => `${directory}/${kind}`,
  };
}

/** The browser site under test: PLUGIN_TEST_SITE or the primary role. */
export const activeTarget = () => browserTarget(process.env.PLUGIN_TEST_SITE || undefined);

/** The installation environment under test: PLUGIN_TEST_ENVIRONMENT or development. */
export function activeEnvironment(env = process.env) {
  const value = env.PLUGIN_TEST_ENVIRONMENT ?? 'development';
  if (!environments.includes(value)) throw Error('Unsupported installation environment.');
  return value;
}

/** Exactly one installation of an app on an owned site and environment. */
export function selectInstallation(
  targets,
  app,
  host,
  environment = process.env.PLUGIN_TEST_ENVIRONMENT ?? 'development',
) {
  if (!ownedSites().includes(host)) throw Error('Owned installation site required.');
  if (!environments.includes(environment)) throw Error('Unsupported installation environment.');
  const matches = targets.filter(
    (x) => x.app === app && x.site === host && x.environment === environment,
  );
  if (matches.length !== 1)
    throw Error(`Exactly one owned ${environment} target required for this site.`);
  return matches[0];
}

/** The configured installation of an app on the active site and environment. */
export const activeInstallation = (app) =>
  selectInstallation(installationTargets(), app, activeTarget().host, activeEnvironment());
