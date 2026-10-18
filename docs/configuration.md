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
  "sites": [
    { "role": "primary", "host": "your-site.atlassian.net", "expiresOn": "2027-01-31" },
    { "role": "isolation", "host": "your-second-site.atlassian.net" }
  ],
  "installations": [
    {
      "app": "my-app",
      "site": "your-site.atlassian.net",
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
| `sites` | The only sites any command will touch, by role. `primary` is the default. `expiresOn` makes lanes refuse an expired site and warn within 30 days |
| `installations` | Forge installations by app, site and environment. The environment ID locates the app's frames and pages: run `forge environments list` in the app's directory and copy that environment's Environment ID. It's also the UUID after the app ID in the address of the app's pages in Jira. `appId` is optional; without it, the app ID is read from `./manifest.yml` |
| `fixtures.apps` | The disposable fixture space for each fixture app (`forge-test prepare` creates or verifies them) |
| `fixtures.projects` | Other named spaces, for example one used by a registered fixture profile |
| `fixtures.identity` | The space whose isolated permission scheme holds the pinned identity accounts ([set up by hand](#identity-fixture)). It also holds the site lease that `forge-test suite` takes |
| `fixtures.landing` | The work item `forge-test login` opens (required by `login`). Without `fixtures.identity`, its space holds the site lease |
| `email`, `keychainService` | Optional. The account email (or `JIRA_EMAIL`), and on macOS a Keychain item holding the API token (or `JIRA_API_KEY`) |

### Advanced: renaming the namespace

If you change `namespace` while fixtures made under the old one are still on a site, list the old one in `legacyNamespaces`. It's recognized but never written, so those fixtures stay verifiable and removable:

```json
{
  "namespace": "acme",
  "legacyNamespaces": [{ "slug": "old-acme", "brand": "Old Acme", "runPrefix": "oa" }]
}
```

`slug` is the earlier namespace as it appeared in labels and property keys, and `brand` as it appeared in descriptions and names. `runPrefix` names an earlier run-marker prefix (`<runPrefix>-e2e-`) when it wasn't the slug.

## Credentials

- **API:** `JIRA_EMAIL` and `JIRA_API_KEY` (a classic Atlassian API token). Without `JIRA_EMAIL`, the configuration's `email` is used, then `email` in `<state>/config.json`.
- **Forge CLI:** `FORGE_EMAIL` and `FORGE_API_TOKEN`, defaulting to the same values.

Values are never printed. `prepare` needs a site administrator: it creates spaces.

## Identity fixture

Journeys that need pinned accounts (the `identity` profile) use one space on the primary site with its own permission scheme. `prepare` doesn't create it; set it up once by hand as a Jira administrator:

1. Create a company-managed software space with the key in `fixtures.identity`. Set its description to exactly `<namespace> owned identity permission fixtures v1. Synthetic data only.`, with your `namespace`.
2. Copy a permission scheme, give the copy the same description, and associate it with this space only. A journey that changes a grant first checks that no other space uses the scheme, and refuses otherwise.
3. In that scheme, grant three distinct accounts:
   - **owner:** the API account (`JIRA_EMAIL`), a Jira administrator who can browse, create, edit, delete and comment on work items in the space;
   - **member:** can browse, edit and comment, but doesn't administer the space or Jira;
   - **restricted:** can browse and edit but not comment, and doesn't administer.
4. Save a session for each: `npx forge-test login admin` as the owner, then `login member` and `login restricted`.
5. Write `sites/<host>/e2e/identity-fixture.json` in the private state. The space ID is the `id` from `GET /rest/api/3/project/<key>`, the scheme ID the `id` from `GET /rest/api/3/project/<key>/permissionscheme`, and each account ID the last part of that person's profile address (`/jira/people/<account id>`):

```json
{
  "site": "https://your-site.atlassian.net",
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
