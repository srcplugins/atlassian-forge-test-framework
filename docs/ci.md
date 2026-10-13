# GitHub Actions

How to run hosted suites in a public repository without exposing sites, accounts or evidence.

## Environment and secrets

Create a GitHub environment (for example `acceptance`) and fill it from a machine with saved sessions:

```sh
npx forge-test secrets --repo owner/name --env acceptance --profiles admin,member --dry-run
```

Run it again without `--dry-run` to set them. Fork pull requests never receive environment secrets.

| Secret | Holds |
|---|---|
| `FORGE_TEST_CONFIG` | The configuration JSON |
| `JIRA_EMAIL`, `JIRA_API_KEY` | A dedicated API token for CI, not a personal one |
| `JIRA_SESSION_<PROFILE>` | Saved sessions, gzip and base64. They expire about 30 days after sign-in; `--dry-run` shows the dates |
| `JIRA_IDENTITY_FIXTURE` | Pinned identity accounts, when used |
| `CI_AGE_KEY` | An [age](https://age-encryption.org) identity that decrypts carried journals |

Also set the `OWNER_AGE_RECIPIENT` variable: the public key of an age identity only you hold.

## Keep logs and artifacts private

1. **Mask first.** Run `forge-test restore` and then `forge-test mask` before anything else prints. Hosts, environment IDs, pinned account IDs and fixture space keys (and so every work item key in those spaces) then show as `***`.
2. **Encrypt evidence.** Reports and failure screenshots are encrypted to `OWNER_AGE_RECIPIENT` alone before upload. CI can't read them back; you decrypt locally with `age -d -i <your key>`.
3. **Carry journals encrypted.** Run journals carry fixture ownership from one run to the next. Encrypt them to both `OWNER_AGE_RECIPIENT` and the CI key's recipient (`age-keygen -y`). The next run decrypts them with `CI_AGE_KEY`, so an unresolved run makes it refuse rather than ignore leftovers. Don't carry locks; a concurrency group replaces them.

## One run at a time

- **Within a repository:** put every hosted job in one concurrency group with `cancel-in-progress: false`. A started run is never cancelled, so its cleanup can finish.
- **Across repositories and machines:** `forge-test suite` holds a site lease while it runs, so apps sharing a site take turns. The lease is a property on the identity space (or the landing work item's space) under the configured namespace, so suites take turns when they share that space and namespace. A suite that finds the site busy logs the holder (repository and run, or "a local run") and waits up to an hour. A holder that disappears loses the lease after 15 minutes. Jira has no atomic lock for this: the lease is a write confirmed by two read-backs and rechecked before every step, so a write delayed past both pauses can overlap until the next step. Individual commands (`lane`, a runner script) don't take the lease; run them only when no suite is running.

## Recovering a failed run

1. Download and decrypt the evidence and journals, and inspect them.
2. Reconcile read-only first.
3. Run `forge-test cleanup <fixture-app> <run-id>` in the workflow, so the carried journal is updated. A cleanup run on your machine doesn't update the CI copy.
