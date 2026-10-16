# Commands

Run them from the app repository with `npx forge-test <command>`. Every command refuses sites that aren't configured.

| Command | Does | Writes to Jira |
|---|---|---|
| `doctor` | Checks the configured account and whether it administers Jira | No |
| `preflight <host>` | Inventories an owned site: canonical URL, account, permissions, seats, a space sample | No |
| `login [profile]` | Opens Chrome on the landing work item; you sign in normally, including MFA, and the session is saved. The script never sees the password | No |
| `prepare` | Creates or verifies each fixture app's marked company-managed space and adds the account to its Administrators role. An earlier attempt that didn't finish stops it | Yes |
| `lane <lane> [--config file] [-- args]` | Runs a Playwright lane with `./playwright.config.mjs` (or `--config`); extra arguments go to Playwright | Through the journeys |
| `suite <name> [--only a,b] [--list]` | Runs a suite from `forge-test.mjs` while holding the site lease. A failed step that cleans up continues to the next step; see [Suites](#suites). `--only` runs the prerequisites plus the steps whose names contain one of the terms | Through its steps, plus the lease property on the identity space (or the landing work item's space) |
| `install [--role r] [-e env] [--upgrade]` | Installs the app on a site role and environment through the module's Forge command, upgrading an existing installation. An unreadable inventory refuses the write | No (Forge) |
| `cleanup <fixture-app> <run-id>` | Recovers one journaled run after a hard stop: rechecks site, space, account and markers, then deletes only that run's resources | Yes |
| `secrets --repo o/r --env e [--profiles a,b] [--dry-run]` | Copies the configuration, credentials, saved sessions and identity pins into a GitHub environment's secrets with `gh`. Prints names, sizes and session expiry dates only | No |
| `restore` | On a CI runner: writes the sessions and identity pins from those secrets into the private state layout | No |
| `mask` | Prints `::add-mask::` lines for owned hosts, environment IDs, pinned account IDs and fixture space keys | No |

## Lanes

| Lane | Opt-in | Runs |
|---|---|---|
| `features` | none | Every `*.features.spec.mjs` in Chrome |
| `compatibility` | `COMPAT_BROWSER=chrome\|firefox\|webkit` | The same suites in another engine. WebKit isn't Safari |

`./playwright.config.mjs` is usually two lines:

```js
import { definePlaywrightConfig } from '@srcplugins/atlassian-forge-test-framework/core';
export default definePlaywrightConfig({ testDir: 'tests/hosted' });
```

## The `forge-test.mjs` module

An optional module in the repository root. The commands load it when they need it:

```js
import { registerProfile } from '@srcplugins/atlassian-forge-test-framework/jira';

// The guarded Forge CLI command that `forge-test install` runs.
export const forge = ['node', 'config/forge.mjs'];

// Suites: ordered steps, each a command, with optional environment variables.
export const suites = {
  features: [
    { name: 'Deploy to development', command: ['node', 'config/forge.mjs', 'deploy', '-e', 'development', '--non-interactive'], prerequisite: true },
    { name: 'Install or upgrade', command: ['npx', 'forge-test', 'install'], prerequisite: true },
    { name: 'Feature journeys', command: ['npx', 'forge-test', 'lane', 'features'], cleanup: 'fixtures' },
    { name: 'Setup runner', command: ['node', 'tests/hosted/verify-setup.mjs', 'run'], cleanup: ['node', 'tests/hosted/verify-setup.mjs', 'cleanup'] },
  ],
};

// Extra fixture profiles; see Writing journeys.
registerProfile('tenant-isolation', { /* project, marker, allow, missing */ });
```

### Suites

Each step gets its own run ID in `FORGE_TEST_RUN_ID`; a runner that journals its own writes should use it as its run ID. When a step fails:

- a `prerequisite` (delivery, install, credentials) stops the suite;
- `cleanup: [command, ...args]` runs that guarded cleanup with the run ID appended, and the suite continues only if it exits 0;
- `cleanup: 'fixtures'` (journeys using `owned`, which always clean up) continues only if every fixture journal is clean;
- a step without `cleanup` stops the suite.

So one run reports every independent failure, and leaves nothing for the next run to refuse on, while anything uncertain still stops it with its journal for inspection. The summary marks each step passed, failed, failed and cleaned up, or not run.

`forge-test cleanup` loads the module first, so a run opened with a registered profile can also be recovered.
