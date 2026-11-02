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
| `JIRA_SESSION_<PROFILE>` | Saved sessions, gzip and base64. They expire about 30 days after their last use; `--dry-run` shows the dates, and `renew` followed by `secrets` keeps them current ([saved sessions](commands.md#saved-sessions)) |
| `JIRA_IDENTITY_FIXTURE` | Pinned identity accounts, when used |
| `CI_AGE_KEY` | An [age](https://age-encryption.org) identity that decrypts carried journals |

Also set the `OWNER_AGE_RECIPIENT` variable: the public key of an age identity only you hold. Optionally set `AGENT_AGE_RECIPIENT` too: the public key of an identity held by whoever debugs failures for you, such as a coding agent on your machine.

## Keep logs and artifacts private

1. **Mask first.** Run `forge-test restore` and then `forge-test mask` before anything else prints. Hosts, environment IDs, pinned account IDs and fixture space keys (and so every work item key in those spaces) then show as `***`.
2. **Encrypt evidence.** Reports and failure screenshots are encrypted to `OWNER_AGE_RECIPIENT` (and `AGENT_AGE_RECIPIENT`, when set) before upload. CI can't read them back; you decrypt locally with `age -d -i <your key>`.
3. **Carry journals encrypted.** Run journals carry fixture ownership from one run to the next. Encrypt them to the same readers and the CI key's recipient (`age-keygen -y`). The next run decrypts them with `CI_AGE_KEY`, so an unresolved run makes it refuse rather than ignore leftovers. Don't carry locks; a concurrency group replaces them.
4. **Restore only your own journals.** In a public repository, a fork pull request's workflow can upload an artifact with the same name, and the CI key's recipient is public, so anyone can encrypt an archive to it. Restore only an artifact whose run came from this repository, and check the archive's members before extracting:

   ```sh
   # REPOSITORY_ID is ${{ github.repository_id }}, set in the step's env.
   id=$(gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/actions/artifacts?name=hosted-state&per_page=100" |
     jq -r --argjson repo "$REPOSITORY_ID" '[.[].artifacts[]
       | select((.expired | not)
                and .workflow_run.repository_id == $repo
                and .workflow_run.head_repository_id == $repo)]
       | max_by(.created_at) | .id // empty')

   # After downloading and decrypting it to $archive: only regular files at
   # sites/<host>/e2e/…runs/<name>.json, which is what the save step writes.
   listing=$(tar -tvzf "$archive")
   members=$(tar -tzf "$archive")
   if [ -n "$members" ] && { grep -qv '^-' <<<"$listing" || grep -qF '..' <<<"$members" ||
     grep -qEv '^sites/[^/]+/e2e/([^/]+/)*[^/]*runs/[^/]+\.json$' <<<"$members"; }; then
     echo "::error::Carried journals contain an unexpected entry"; exit 1
   fi
   tar -xzf "$archive" -C .local --no-same-owner --no-same-permissions
   ```

   Keep the checks off pipelines: with `shell: bash` (`pipefail`), `tar … | grep -q` can pass a bad entry when `grep` exits early.

## One run at a time

- **Within a repository:** put every hosted job in one concurrency group with `cancel-in-progress: false`. A started run is never cancelled, so its cleanup can finish.
- **Across repositories and machines:** `forge-test suite` holds a site lease while it runs, so apps sharing a site take turns. The lease is a property on the identity space (or the landing work item's space) under the configured namespace, so suites take turns when they share that space and namespace. The lease records its holder and when it was taken. A suite that finds the site busy logs the holder and how long it has held the site, and waits up to an hour; if the site is still busy then, it stops with the same message. A holder that disappears (a killed job or a stopped `lane`) loses the lease after 15 minutes. Jira has no atomic lock for this: the lease is a write confirmed by two read-backs and rechecked before every step, so a write delayed past both pauses can overlap until the next step.
- **Lanes:** `lane` takes the lease too, and holds it while Playwright runs, so a suite started meanwhile waits for it and another lane refuses. A lane doesn't wait: while another run holds the site it refuses at once, naming the run and how long it has held the site, so an interactive caller can do something else and try again, where a waiting lane would hide the conflict. A suite's own lanes get its lease ID (`FORGE_TEST_LEASE`) and run under it. Your own runner scripts don't check the lease, so run them only within a suite or when no run holds the site.
- **Holder names:** a run on GitHub Actions is named by its repository and run ID. Elsewhere it's "a local suite" or "a local lane", or `FORGE_TEST_LEASE_HOLDER` with the kind of run added (for example `FORGE_TEST_LEASE_HOLDER="nightly box"` shows "nightly box (lane)"). The name is written into the lease and printed in other runs' logs, so use a public label, never a host or account.
- **Who holds it:** `forge-test lease` shows the holder, for how long and when the lease lapses, without writing anything; `--json` gives the same for a script. In code, `siteLease(api).status()` from `/jira` returns `{ holder, since, heldMs, expires, own, priorityWaiting }`, or null when the site is free.
- **Releases first:** a suite run with `FORGE_TEST_LEASE_PRIORITY=1` (set it for release and main-branch runs, not for routine pushes) goes ahead of the others. While it waits, it keeps a reservation next to the lease, renewed every poll and lapsing within 90 seconds once it stops. Other waiters leave a free site to it, and a suite holding the site gives way before its next step that isn't a prerequisite: it logs "Pausing for …", releases the lease, and waits up to two hours to get it back. The priority run may deploy over it, so its passed prerequisites (the deploy and install) run again before it continues; the summary and receipt show the pause. A priority run never gives way, and two priority runs take turns as before. A release then waits for one step of another suite (at most the longest step), not the rest of it. A lane outside a suite doesn't give way: the release waits for it to finish.

## Recovering a failed run

`forge-test suite` cleans up a failed step itself when the step declares a cleanup ([Suites](commands.md#suites)). Recover by hand only when that cleanup refused or the job stopped:

1. Download and decrypt the evidence and journals, and inspect them.
2. Reconcile read-only first.
3. Run `forge-test cleanup <fixture-app> <run-id>` in the workflow, so the carried journal is updated. A cleanup run on your machine doesn't update the CI copy.
