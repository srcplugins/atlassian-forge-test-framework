# Atlassian Forge test framework

Hosted acceptance testing for Atlassian Forge apps, run against Atlassian sites you own. It's what [srcplugins](https://srcplugins.com) apps use to test their deployed code in real Jira before every release.

- **Disposable fixtures with a journal.** Every write is recorded before it happens. Cleanup deletes only what the run created, after re-checking ownership, and an uncertain write is never retried.
- **Owned sites only.** Every command refuses a site that isn't in your configuration.
- **Playwright lanes** for Chrome journeys: serial, no retries, stop at the first failure.
- **Jira helpers:** a REST client, work item panel and space page locators, theme handling, Rovo agent selection and resolver observation.
- **CI support:** credentials and private evidence stay out of public logs.

Jira is supported today. The shared parts are in `core`, so another Atlassian product can be added beside `jira`.

## Install

Install it from GitHub at a release tag:

```sh
npm install --save-dev github:srcplugins/atlassian-forge-test-framework#v0.3.0 @playwright/test@1.63.0
```

It needs Node 24 and Google Chrome.

## Use

1. Write the configuration: your sites, installations and fixture spaces. See [configuration](docs/configuration.md).
2. Save a browser session for each account your tests use: `npx forge-test login admin`.
3. Create or verify the fixture spaces: `npx forge-test prepare`.
4. Write journeys as `*.features.spec.mjs` with the `test` fixtures from `@srcplugins/atlassian-forge-test-framework/jira`, and run them with `npx forge-test lane features`.

| Topic | Read |
|---|---|
| Configuration and private state | [docs/configuration.md](docs/configuration.md) |
| Commands and the `forge-test.mjs` module | [docs/commands.md](docs/commands.md) |
| Writing journeys | [docs/journeys.md](docs/journeys.md) |
| GitHub Actions | [docs/ci.md](docs/ci.md) |

## License

Source-available under the [PolyForm Internal Use License 1.0.0](LICENSE.md): you can use, change and run it for your own organization's internal purposes, including testing your own apps, but not distribute it.
