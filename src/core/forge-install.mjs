import { siteFor } from './config.mjs';

// Forge installation arguments for an owned site role and environment. The caller runs them
// through its own guarded Forge CLI wrapper; production still needs that wrapper's opt-in.
export function installOptions(args) {
  let role = 'primary';
  let environment = 'development';
  let upgrade = false;
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split('=');
    const key = ['-e', '--environment'].includes(flag) ? 'environment' : flag;
    if (seen.has(key)) throw Error(`Duplicate installation option: ${flag}`);
    seen.add(key);
    if (flag === '--upgrade' && inline === undefined) upgrade = true;
    else if (['--role', '-e', '--environment'].includes(flag)) {
      const value = inline ?? args[++i];
      if (!value || value.startsWith('-')) throw Error(`Missing value for ${flag}`);
      if (flag === '--role') role = value;
      else environment = value;
    } else throw Error(`Unsupported installation option: ${flag}`);
  }
  if (!['development', 'staging', 'production'].includes(environment))
    throw Error('Unsupported installation environment.');
  return { site: siteFor(role), role, environment, upgrade };
}

/** Whether `forge install list --json` rows show the installation. Malformed input refuses. */
export function installedOn(rows, site, environment, product = 'jira') {
  if (!Array.isArray(rows)) throw Error('Installation inventory must be an array.');
  if (
    rows.some(
      (entry) =>
        !entry ||
        ['site', 'environment', 'product'].some(
          (key) => typeof entry[key] !== 'string' || !entry[key],
        ),
    )
  )
    throw Error('Malformed installation inventory; install refused.');
  const matches = rows.filter(
    (entry) =>
      entry.site === site &&
      entry.environment === environment &&
      entry.product.toLowerCase() === product,
  );
  if (matches.length > 1) throw Error('Ambiguous installation inventory.');
  return matches.length === 1;
}

/** `forge install` arguments; an existing installation is upgraded, never installed twice. */
export function installArguments(options, installed, product = 'jira') {
  return [
    'install',
    '--non-interactive',
    ...(installed || options.upgrade ? ['--upgrade'] : []),
    '--site',
    options.site,
    '--product',
    product,
    '-e',
    options.environment,
  ];
}
