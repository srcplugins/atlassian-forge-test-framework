# Atlassian Forge test framework

Hosted acceptance testing for Atlassian Forge apps, run against Atlassian sites you own. It's what [srcplugins](https://srcplugins.com) apps use to test their deployed code in real Jira before every release.

- **Disposable fixtures with a journal.** Every write is recorded before it happens. Cleanup deletes only what the run created, after re-checking ownership, and an uncertain write is never retried.
- **Owned sites only.** Every command refuses a site that isn't in your configuration.
- **Playwright lanes** for Chrome journeys: serial, no retries, stop at the first failure.
- **A page guard on every journey:** a test fails when Jira shows an error flag it didn't declare, or when the app's frame stays behind Jira's loading placeholder, even if every assertion of its own passed.
- **Jira helpers:** a REST client, work item panel and space page locators, theme handling, Rovo agent selection and resolver observation.
- **CI support:** credentials and private evidence stay out of public logs.

Jira is supported today. The shared parts are in `core`, so another Atlassian product can be added beside `jira`.

## Install

Install it from GitHub at a release tag:

```sh
npm install --save-dev github:srcplugins/atlassian-forge-test-framework#v0.3.1 @playwright/test@1.63.0
```

It needs Node 24 and Google Chrome.

**Stability:** 0.x, so breaking changes can land in any minor release. Pin a tag, and read the [changelog](CHANGELOG.md) before you move it.

## Use

1. Write the configuration: your sites, installations and fixture spaces. See [configuration](docs/configuration.md).
2. Deploy the app with `forge deploy -e development`. To install it, name your Forge CLI command in a `forge-test.mjs` module in the repository root (`export const forge = ['forge'];`), then run `npx forge-test install`. It installs the app on the primary site, or upgrades the installation that's already there ([commands](docs/commands.md)).
3. Save a browser session for each account your tests use: `npx forge-test login admin`.
4. Create or verify the fixture spaces: `npx forge-test prepare`.
5. Write journeys as `*.features.spec.mjs` with the `test` fixtures from `@srcplugins/atlassian-forge-test-framework/jira`, and run them with `npx forge-test lane features`.

For a complete example, see [Agent Prompts](https://github.com/srcplugins/atlassian-jira-agent-prompts), which tests itself with this framework. Its [`forge-test.mjs`](https://github.com/srcplugins/atlassian-jira-agent-prompts/blob/main/forge-test.mjs) defines the suites and the Forge command, [`tests/hosted/`](https://github.com/srcplugins/atlassian-jira-agent-prompts/tree/main/tests/hosted) holds the journeys and runners, and [`.github/workflows/hosted.yml`](https://github.com/srcplugins/atlassian-jira-agent-prompts/blob/main/.github/workflows/hosted.yml) runs them in GitHub Actions.

| Topic | Read |
|---|---|
| Configuration and private state | [docs/configuration.md](docs/configuration.md) |
| Commands and the `forge-test.mjs` module | [docs/commands.md](docs/commands.md) |
| Writing journeys | [docs/journeys.md](docs/journeys.md) |
| GitHub Actions | [docs/ci.md](docs/ci.md) |
| Changes by release | [CHANGELOG.md](CHANGELOG.md) |

## License

Source-available under the [PolyForm Internal Use License 1.0.0](LICENSE.md): you can use, change and run it for your own organization's internal purposes, including testing your own apps, but not distribute it.
