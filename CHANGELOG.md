# Changelog

## Unreleased

- **Saved sessions:** `lane`, `suite` and `restore` refuse to run with an expired saved session and name the profile to renew with `forge-test login`; one expiring within a week warns (a GitHub annotation on a runner). `secrets` refuses to copy an expired session.
- **Lanes and the site lease:** `forge-test lane` refuses to start while another run holds the site lease and names that run, so a local lane can't share fixture spaces with a running suite. A suite's own lanes run under its lease.
- **Cleanup:** a fixture whose recorded custom field value differs is cleaned up when Jira's history shows no change since the create, as when a journey recorded a save and failed before making it. Before, cleanup refused it and the run's journal stayed unresolved.
- **Suite receipts:** every `forge-test suite` run writes a JSON receipt (suite, directory, result, and each step's outcome and times) to `sites/<host>/e2e/suites/` in the private state, for measuring first-pass rates and repair time.
- **Page guard:** every test from `/jira` fails when Jira shows an error flag the test didn't declare ("Created Story with exceptions", "Something went wrong", "We couldn't load …") or when an app frame stays behind Jira's loading placeholder for longer than `appLoadLimit` (15 s). Declare expected flags with `test.use({ expectedFlags })` or `pageGuard.allowFlag(pattern)`.
- **Create-form fixtures:** `owned.browserIssue` returns once Jira shows the Create outcome flag, and fails at once if it's an error, so a field that Jira couldn't save after the create fails the test.

## 0.3.1

- **Create-form fixtures:** `owned.browserIssue(summary, typeId, { fill, submit })` journals a work item that the journey creates through Jira's own Create form. The run marker ends its summary and the work item is found by it. A failure while filling the form wrote nothing; a failed submit is reconciled by reading, never repeated.

## 0.3.0

First public release.

- **Configuration:** one JSON object, from an environment variable, a file or `.local/forge-test.json`, names your owned sites, Forge installations, fixture spaces and marker namespace. Every command refuses a site it doesn't list.
- **Commands:** `forge-test doctor`, `preflight`, `login`, `prepare`, `install`, `lane`, `suite` and `cleanup`, plus `secrets`, `restore` and `mask` for CI.
- **Journaled fixtures:** the `owned` fixture creates marked work items in a fixture space and records intent before every write. A failed create is reconciled by reading, never repeated. Cleanup rechecks markers and fields and deletes only what the run created, and `forge-test cleanup` recovers a run after a hard stop.
- **Fixture profiles:** `standard` (the app's fixture space), `identity` (pinned accounts in an isolated permission scheme), and your own through `registerProfile`, including team-managed spaces.
- **Suites:** ordered steps from `forge-test.mjs` with prerequisites and per-step cleanup, so one run reports every independent failure. A site lease makes suites that share a site take turns.
- **Playwright lanes:** `features` in Chrome and `compatibility` in Chrome, Firefox or WebKit; serial, no retries.
- **Jira helpers:** a REST client whose transport failures name the stage and the kind of failure but never a message, header or body, space page and work item panel locators, resolver observation, theme changes that are restored afterwards, a contrast check, Rovo agent selection and Jira's first-run dialog.
- **CI:** state copied into GitHub environment secrets, private values masked in logs, and evidence and carried run journals encrypted with age.
