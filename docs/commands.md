# Commands

Run them from the app repository with `npx forge-test <command>`. Every command refuses sites that aren't configured.

| Command | Does | Writes to Jira |
|---|---|---|
| `doctor` | Checks the configured account and whether it administers Jira (for a [Confluence app](confluence.md), that it is a known Confluence user who can read spaces) | No |
| `preflight <host>` | Inventories an owned site: canonical URL, account, permissions, seats, a space sample | No |
| `login [profile]` | Opens Chrome on the landing work item; you sign in normally, including MFA, and the session is saved. The script never sees the password | No |
| `renew [profile...]` | Extends saved sessions without a sign-in (all dated ones by default): opens the landing work item and the Atlassian account page in headless Chrome, then saves a session again only when Jira still returns its account and the sign-in lasts longer than before. Atlassian extends the account's sign-in only so often, so a session renewed shortly before reports `current`. Prints profile names and dates only; exits non-zero when a session has expired, is signed out, or wasn't extended within a week of expiring | No |
| `sessions [profile...] [--verify] [--json]` | Lists the saved sessions on the site under test (or the named profiles): when each was saved and when its sign-in lapses, from the files alone. `--verify` also asks Jira who each unexpired session is (`/myself` through that session, without a browser) and compares the account with the identity pins: each line says which pinned role (`owner`, `member`, `restricted`) the account is, or that it is unpinned, and which other listed profiles share it. Accounts appear only as their last four characters. `--json` prints `{ "verified", "pins", "sessions": [{ "profile", "saved", "expires", "expired", "missing", "verify": { "signedIn", "account", "pin", "sameAs" } or { "error" } }] }`. Exits non-zero when a session is missing, expired, signed out or couldn't be checked | No |
| `prepare` | Creates or verifies each fixture app's marked company-managed space and adds the account to its Administrators role (for a Confluence app, each marked space in `fixtures.confluenceSpaces`). An earlier attempt that didn't finish stops it | Yes |
| `lane <lane> [--config file] [-- args]` | Runs a Playwright lane with `./playwright.config.mjs` (or `--config`); extra arguments go to Playwright. Holds the site lease while it runs, and refuses at once while another run holds it, naming that run and how long it has held the site ([CI](ci.md#one-run-at-a-time)) | Through the journeys, plus the lease property |
| `suite <name> [--only a,b] [--list]` | Runs a suite from `forge-test.mjs` while holding the site lease. A failed step that cleans up continues to the next step; see [Suites](#suites). `--only` runs the prerequisites plus the steps whose names contain one of the terms | Through its steps, plus the lease property on the identity space (or the landing work item's space) |
| `lease [--json]` | Shows who holds the site lease (every holder, while runs share the site), since when and for how long, when it lapses unless renewed, and any priority run waiting. `--json` prints `{ "held": false }` or `{ "held": true, "holder", "since", "heldMinutes", "expires", "priorityWaiting" }` (times in ISO 8601; `since` and `heldMinutes` are null for a lease written by an earlier version) | No |
| `install [--role r] [-e env] [--upgrade]` | Installs the app on a site role and environment through the module's Forge command, upgrading an existing installation. An unreadable inventory refuses the write | No (Forge) |
| `cleanup <fixture-app> <run-id>` | Recovers one journaled run after a hard stop: rechecks site, space, account and markers, then deletes only that run's resources. A create whose response was lost is closed as never created when, five minutes after it was recorded, no work item in the space has its summary or marker | Yes |
| `secrets --repo o/r --env e [--profiles a,b] [--sessions-only] [--dry-run]` | Copies the configuration, credentials, saved sessions and identity pins into a GitHub environment's secrets with `gh`; `--sessions-only` copies just the named sessions, as after `renew`. Prints names, sizes and session expiry dates only | No |
| `restore` | On a CI runner: writes the sessions and identity pins from those secrets into the private state layout | No |
| `mask` | Prints `::add-mask::` lines for owned hosts, environment IDs, pinned account IDs and fixture space keys | No |

## Saved sessions

Atlassian sign-ins last about 30 days from their last use. A session has two dated sign-in cookies: the site's (`tenant.session.token`), which Jira extends whenever the session opens the site, and the Atlassian account's (`cloud.session.token`), which id.atlassian.com extends, but not on every visit: a second renewal shortly after the first may extend only the site's cookie. A session's expiry is the earlier of the two.

`renew` extends sessions while they're still valid, so a machine that keeps the sessions can run it on a schedule (daily, for example) and copy the result with `secrets`; nobody signs in again unless a session expires or is signed out. An expired session needs `login`.

`sessions` shows the same dates on demand, and `sessions --verify` confirms each session still signs in as the account it should, so a session saved under the wrong account shows up before a run uses it.

`lane`, `suite` and `restore` check every saved session first. If one has expired, the run stops before signing in and names the profile to sign in again with `login`. One that expires within a week prints a warning that names `renew`, and on a GitHub runner that warning is an annotation on the run. `secrets` refuses to copy an expired session.

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

Each run also leaves a receipt in the site's private state, `sites/<host>/e2e/suites/<suite>-<time>-<pid>.json`: the suite, the directory it ran in, the result, and each step's outcome with its start and finish times. A step whose journeys found an app that wasn't ready also lists them, `readiness: [{ test, stage }]`, with the [readiness stage](journeys.md#app-readiness) that failed, and the summary shows them beside the step's result. Like the summary it holds names, timings and stage words only. Read a series of them to measure how often a step passes first time and how long a failure takes to fix.

A step's tests record those failures in the file the suite names in `FORGE_TEST_STEP_RESULT`, one JSON line each (`{ "kind": "app-readiness", "test", "stage" }`); the page guard fixture does this itself, and `recordStepResult(records)` from `/core` lets a runner do the same.

`forge-test cleanup` loads the module first, so a run opened with a registered profile can also be recovered.
