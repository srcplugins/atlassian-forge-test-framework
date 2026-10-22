# Writing journeys

A journey creates what it needs in a marked fixture space, exercises the deployed app in Chrome, checks the result with independent Jira reads, then deletes exactly what it created.

```js
import { test, expect, projectPage } from '@srcplugins/atlassian-forge-test-framework/jira';

test.use({ fixtureApp: 'my-app' });

test('MY-01 a saved setting survives a reload', async ({ page, owned }) => {
  const issue = await owned.issue('Synthetic target');
  await projectPage(page, 'my-app', owned.project.key);
  // ...exercise the app, then assert facts read independently through owned.api
  expect((await owned.api(`/issue/${issue.id}?fields=summary`)).fields.summary).toBe(
    issue.expected.summary,
  );
});
```

## The `owned` fixture

`owned` opens a journaled run in the fixture app's space, then cleans it up after the test. Cleanup still runs when assertions fail.

| Member | Use |
|---|---|
| `issue(summary, labels?)` | A label-marked disposable work item |
| `propertyIssue(summary, body, typeId)` | A work item of a chosen work type, marked by a work item property instead of a label |
| `browserIssue(summary, typeId, { fill, submit })` | A work item created through Jira's own Create form: `fill(summary)` opens and fills the form, `submit()` makes the one click that creates it, the run marker ends the summary, and the Description stays empty. A failure in `fill` wrote nothing and cleans up at once; one in `submit` is reconciled by reading. It returns once Jira shows the Create outcome flag (up to 20 s), and fails at once if that flag is an error, such as "Created Task with exceptions" ([page guard](#the-page-guard)) |
| `api`, `project`, `user`, `run` | The Jira client, the fixture space, the account and the journal |

## The page guard

Every test that uses `test` (or `themeTest`) from `/jira` gets the `pageGuard` fixture automatically. It watches every page of the test's browser context and fails the test at its end when either happened, however its own assertions went:

- **Jira showed an error flag.** A flag is Jira's toast (an element with role `alert` and a heading). It's an error when its text contains "with exceptions", "something went wrong", "couldn't", "could not", "unable to", "failed to" or the word "error": for example "Created Story with exceptions: We couldn't save the value of the Agent Prompts field", or "We couldn't load …".
- **An app never loaded.** While a Forge app loads, Jira shows Forge's skeleton placeholder beside the app's iframe and keeps the iframe hidden. A Custom UI app has loaded once its iframe is visible; a UI Kit app renders into Jira's page beside an iframe that stays hidden, and has loaded once that content shows. A displayed app iframe (its `src` contains the app ID) still behind the skeleton, or still hidden with nothing rendered beside it, after `appLoadLimit` fails the test. Frames in collapsed sections don't count until they're displayed.

A failure names the flag or the frame and saves `page-guard.png` in the test's output directory. Each flag the guard saw is a `jira-flag` annotation in the report, and each app frame's load time an `app-frame-ms` annotation.

| Option (`test.use`) | Default | Use |
|---|---|---|
| `expectedFlags` | `[]` | Error flags the tests expect: strings contained in the flag's text, or regular expressions. A declared flag doesn't fail the test; any other error flag still does |
| `appLoadLimit` | `15000` | Milliseconds an app frame may stay behind the loading placeholder |
| `appIds` | the app ID in `./manifest.yml` | The app IDs whose frames are checked. Under `forge tunnel`, frames are served from `localhost` and aren't checked |

Inside a test, `pageGuard.allowFlag(pattern)` declares an expected flag for that test only, `pageGuard.flags` lists the flags seen so far, and `pageGuard.check()` fails at once rather than at the end. The guard watches only the test's own context: a page opened in another context with `browser.newContext()` isn't watched.

```js
test('MY-07 an unreachable service is reported', async ({ page, owned, pageGuard }) => {
  pageGuard.allowFlag(/^We couldn't reach the service/);
  // ...
});
```

## Rules the journal enforces

- **Locks.** One run per fixture space at a time; a suite also holds the site lease ([CI](ci.md#one-run-at-a-time)).
- **Markers.** Everything a run writes carries the namespace: labels and properties use `markers.runMarker`, and a resource your own runner creates should use `markers.acceptance(name, detail)`, so two apps on one site never mistake each other's fixtures.
- **Unresolved runs.** An unresolved earlier run on the same space stops a new one; recover it with `forge-test cleanup`.
- **Intent before writes.** Intent is recorded before every create. A failed create is reconciled by reading, never by repeating the request. Cleanup removes a work item found that way only while it is still as created: its run marker, summary and description match, this run's account reported it, it has the requested type, and nothing was added to it. Jira stores a create's marker property just after the work item, so creation rereads a missing marker a few times (about 4 s) before failing. A work item whose create answered but whose check at creation failed is removed under the same conditions, and only while Jira's history shows no change since the create.
- **Cleanup checks.** Cleanup rechecks the space marker, then each resource's identity, markers and fields, and confirms each deletion independently. A custom field that differs from the journal, such as a save that landed after its test stopped, passes only when Jira's history shows that every change to the work item was made by the run's account during the run, or shows no change at all since the create (a save the journey recorded but never made).

  It refuses resources that have gained dependents (subtasks, links, attachments, work logs, comments). A refusal leaves the journal as `cleanup-required` for inspection.

## Changing a fixture

A journey that changes a fixture work item records the change on its `expected` before writing, calls `owned.run.persist()`, then writes through `owned.api`. Cleanup then accepts the recorded values and still compares everything else.

| `expected` field | Records |
|---|---|
| `descriptionVariants` | Every Description the work item may have, including the one it was created with |
| `customField` | `{ id, value }`: the custom field's expected value |
| `statusIds` | Every status ID the work item may be in, including the one it was created in. Statuses compare by ID only |

## Profiles

`standard` uses the fixture app's space and `identity` uses the pinned identity space; both are company-managed. Register others in `forge-test.mjs`:

```js
import { markers } from '@srcplugins/atlassian-forge-test-framework/core';
import { registerProfile } from '@srcplugins/atlassian-forge-test-framework/jira';

registerProfile('tenant-isolation', {
  project: () => 'ISO',
  marker: () => markers.browserProject('tenant-isolation'),
  allow: ({ app, host }) => {
    if (process.env.MY_ISOLATION_TESTS !== '1') throw Error('Explicit opt-in required');
  },
  missing: 'Marked ISO space required.',
});
```

A profile for a team-managed space adds `style: 'next-gen'`; a run then refuses the space unless Jira reports that style, as it refuses a non-company-managed space otherwise. `prepare` creates only company-managed spaces, so a repository creates its team-managed space with its own journaled runner. A suite selects a profile for the `owned` fixture with `test.use({ fixtureProfile: 'name' })`.

Recovery always uses the profile saved in the journal.

## Other helpers

| Helper | Use |
|---|---|
| `installation(app)` | The installation under test, with app and environment IDs |
| `projectPage(page, app, key)` | Opens the app's space page |
| `panel(page, app, key, label)` | Opens the app's work item panel |
| `observeAction(page, action, exercise, target, projectId?)` | Waits for one resolver response for an exact installation and returns its value |
| `themeTest` | Journals the account's theme, lets the test change it, then restores it. Setting Light or Dark returns once a fresh load of the theme page shows it, since Jira saves the choice a moment after applying it, so open the page under test afterwards. The menu opens from `/jira/your-work`; `test.use({ themePage: '/browse/KEY-1' })` picks another page |
| `textContrast(locator)` | Asserts a 4.5:1 contrast ratio |
| `openRovoChat`, `askRovo` (from `./browser`) | Selects one Rovo agent unambiguously and asks it something. Jira facts, not agent prose, prove results |
| `dismissOnboarding(page)` | Completes Jira's first-run dialog whenever it appears |
