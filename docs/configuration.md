# Configuration

Everything specific to your sites and accounts lives in one JSON object. Nothing about a site is in code.

## Where it comes from

The first match wins:

1. The `FORGE_TEST_CONFIG` environment variable, holding the JSON. In CI it's a secret.
2. The file named by `FORGE_TEST_CONFIG_FILE`.
3. `.local/forge-test.json` in the current directory. Keep `.local/` git-ignored.

## Shape

```json
{
  "namespace": "acme",
  "legacyNamespaces": [{ "slug": "old-acme", "brand": "Old Acme", "runPrefix": "oa" }],
  "sites": [
    { "role": "primary", "host": "acme-test.atlassian.net", "expiresOn": "2027-01-31" },
    { "role": "isolation", "host": "acme-second.atlassian.net" }
  ],
  "installations": [
    {
      "app": "my-app",
      "site": "acme-test.atlassian.net",
      "environment": "development",
      "environmentId": "00000000-0000-4000-8000-000000000000"
    }
  ],
  "fixtures": {
    "apps": { "my-app": "MYAPP" },
    "projects": { "tenant-isolation": "ISO" },
    "identity": "AUTH",
    "landing": "DEV-1"
  },
  "email": "you@example.com",
  "keychainService": "my-jira-api-token"
}
```

| Field | Meaning |
|---|---|
| `namespace` | Written into every marker the harness puts on a site (space descriptions, labels, properties), so cleanup can recognize what it owns |
| `legacyNamespaces` | Earlier namespaces, recognized but never written, so fixtures made before a rename stay verifiable and removable. `runPrefix` names an earlier run-marker prefix (`<runPrefix>-e2e-`) when it wasn't the slug |
| `sites` | The only sites any command will touch, by role. `primary` is the default. `expiresOn` makes lanes refuse an expired site and warn within 30 days |
| `installations` | Forge installations by app, site and environment. The environment ID locates the app's frames and pages. `appId` is optional; without it, the app ID is read from `./manifest.yml` |
| `fixtures.apps` | The disposable fixture space for each fixture app (`forge-test prepare` creates or verifies them) |
| `fixtures.projects` | Other named spaces, for example one used by a registered fixture profile |
| `fixtures.identity` | The space whose isolated permission scheme holds the pinned identity accounts. It also holds the site lease that `forge-test suite` takes |
| `fixtures.landing` | The work item `forge-test login` opens (required by `login`). Without `fixtures.identity`, its space holds the site lease |
| `email`, `keychainService` | Optional. The account email (or `JIRA_EMAIL`), and on macOS a Keychain item holding the API token (or `JIRA_API_KEY`) |

## Credentials

- **API:** `JIRA_EMAIL` and `JIRA_API_KEY` (a classic Atlassian API token). Without `JIRA_EMAIL`, the configuration's `email` is used, then `email` in `<state>/config.json`.
- **Forge CLI:** `FORGE_EMAIL` and `FORGE_API_TOKEN`, defaulting to the same values.

Values are never printed. `prepare` needs a site administrator: it creates spaces.

## Identity fixture

Journeys that need pinned accounts (the `identity` profile) read `sites/<host>/e2e/identity-fixture.json` from the private state:

```json
{
  "site": "https://acme-test.atlassian.net",
  "project": { "id": "10010", "key": "AUTH" },
  "scheme": { "id": "10001" },
  "actors": { "owner": "<account id>", "member": "<account id>", "restricted": "<account id>" }
}
```

`project.key` must equal `fixtures.identity`, `scheme` is the space's isolated permission scheme, and the three actors are distinct Atlassian account IDs. `forge-test secrets` copies the file into `JIRA_IDENTITY_FIXTURE`.

## Selecting a site and environment

| Variable | Default | Selects |
|---|---|---|
| `JIRA_SITE` | the `primary` role | API site |
| `PLUGIN_TEST_SITE` | the `primary` role | Browser site and private state. Must match `JIRA_SITE` |
| `PLUGIN_TEST_ENVIRONMENT` | `development` | Installation environment: `development`, `staging` or `production` |

## Private state

Sessions, run journals, locks and reports live under `.local/` in the current directory. `FORGE_TEST_STATE` (an absolute path) or the configuration's `state` field can point elsewhere. Layout per site:

| Path | Contents |
|---|---|
| `sites/<host>/browser-auth/<profile>.json` | Saved sessions (credentials; mode 0600) |
| `sites/<host>/e2e/runs/<uuid>.json` | Run journals: resource IDs and cleanup state, kept after deletion |
| `sites/<host>/e2e/<kind>-report.json`, `<kind>-results/` | Latest report and failure screenshots |
| `sites/<host>/e2e/identity-fixture.json` | Pinned identity accounts, when used |

Never commit any of it. Never copy sessions between sites or profiles.
