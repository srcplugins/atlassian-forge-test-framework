import { projectAdminFixture } from './permission-grants.mjs';
import { identityFixture } from './identity.mjs';
import { isMarker, isRunMarker, markerForms, markers } from '../core/markers.mjs';
import { checkFixturePermissions } from './fixture-permissions.mjs';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { FixtureRun } from '../core/run-journal.mjs';
import { site, projects, client, allIssues, comments } from './client.mjs';
import { adf } from './adf.mjs';
import { activeTarget } from '../core/target.mjs';
const same = (a, b) => assert.deepEqual(a, b);

// Fixture profiles select the owned space a run writes to. `standard` is the fixture app's own
// space and `identity` the pinned identity space, both company-managed. A consumer registers
// further profiles (registerProfile) before opening or recovering such a run: { project(app) ->
// key, marker(app) -> space description marker, allow({ app, host }) throws when not allowed,
// missing: message when the marked space is absent, style?: 'classic' (default) or 'next-gen'
// for a team-managed space }.
const profiles = new Map();
export function registerProfile(name, definition) {
  if (!/^[a-z][a-z0-9-]*$/.test(name) || ['standard', 'identity'].includes(name))
    throw Error('Invalid fixture profile name');
  if (
    ['project', 'marker', 'allow'].some((key) => typeof definition?.[key] !== 'function') ||
    typeof definition.missing !== 'string'
  )
    throw Error('Fixture profile needs project, marker, allow and missing');
  if (definition.style !== undefined && !['classic', 'next-gen'].includes(definition.style))
    throw Error('Fixture profile style must be classic or next-gen');
  profiles.set(name, definition);
}
const known = (profile) => ['standard', 'identity'].includes(profile) || profiles.has(profile);

export async function openRun(
  request,
  app,
  { recover, directory = activeTarget().runs, profile = 'standard' } = {},
) {
  if (!projects()[app]) throw Error('Unsupported fixture app');
  // The identity profile uses the pinned identity space, validated below; the lane that
  // selects it owns its app-specific eligibility checks.
  if (!known(profile)) throw Error('Unsupported fixture profile');
  if (recover && !/^[0-9a-f-]{36}$/.test(recover)) throw Error('Invalid run ID');
  // Recovery resolves the saved profile before any space operation; no caller-selected alternate target.
  if (recover)
    profile = JSON.parse(readFileSync(`${directory}/${recover}.json`)).fixtureProfile ?? 'standard';
  if (!known(profile)) throw Error('Unsupported saved fixture profile');
  const extension = profiles.get(profile);
  extension?.allow({ app, host: activeTarget().host });
  const identity = profile === 'identity' ? identityFixture() : null;
  const projectKey = extension
    ? extension.project(app)
    : (identity?.project.key ?? projects()[app]);
  const marker = identity
    ? markers.identityProject
    : extension
      ? extension.marker(app)
      : markers.browserProject(app);
  const api = client(request);
  const project = await api(`/project/${projectKey}`);
  if (
    !isMarker(project?.description, marker) ||
    project.key !== projectKey ||
    project.style !== (extension?.style ?? 'classic') ||
    project.projectTypeKey !== 'software'
  )
    throw Error(extension?.missing ?? 'Owned isolated fixture space required. Run prepare.');
  const user = await api('/myself');
  if (!user?.accountId) throw Error('Authenticated fixture identity required');
  const verifyIdentityProject = async () => {
    if (
      identity &&
      (project.id !== identity.project.id ||
        user.accountId !== identity.actors.owner ||
        String((await api(`/project/${project.id}/permissionscheme`))?.id) !== identity.scheme.id)
    )
      throw Error('Identity fixture space, scheme or setup actor mismatch');
  };
  await verifyIdentityProject();
  await checkFixturePermissions(api, project.id);
  mkdirSync(directory, { recursive: true });
  const runId = recover ?? randomUUID();
  if (!/^[0-9a-f-]{36}$/.test(runId)) throw Error('Invalid run ID');
  const lock = `${directory}/${project.id}.lock`;
  if (existsSync(lock)) {
    const holder = JSON.parse(readFileSync(lock));
    if (!recover || holder.runId !== recover) throw Error('Fixture space is locked');
    let alive = true;
    try {
      process.kill(holder.pid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') alive = false;
      else {
        // eslint-disable-next-line preserve-caught-error -- Keep private process diagnostics out of test errors.
        throw Error('Cannot verify lock owner');
      }
    }
    if (alive) throw Error('Fixture owner process still running');
    unlinkSync(lock);
  }
  const fd = { flag: 'wx', mode: 0o600 };
  writeFileSync(lock, JSON.stringify({ runId, pid: process.pid }), fd);
  const path = `${directory}/${runId}.json`;
  const save = (state) => {
    writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  };
  let run;
  try {
    for (const name of readdirSync(directory).filter((n) => n.endsWith('.json'))) {
      const state = JSON.parse(readFileSync(`${directory}/${name}`));
      if (
        state.site === site() &&
        state.projectId === project.id &&
        state.status !== 'clean' &&
        state.runId !== recover
      )
        throw Error(`Unresolved fixture run ${state.runId}`);
    }
    const verifyProject = async () => {
      const p = await api(`/project/${project.id}`);
      if (p?.id !== project.id || p.key !== projectKey || !isMarker(p.description, marker))
        throw Error('Space ownership changed');
      await verifyIdentityProject();
    };
    const issueRead = (id) =>
      api(
        `/issue/${id}?fields=summary,labels,description,project,issuetype,subtasks,attachment,issuelinks,status,assignee,reporter,priority,versions,fixVersions,components,duedate,timetracking,worklog&properties=${markerForms(markers.fixtureProperty).join(',')}`,
      );
    // Jira's history shows changes to the work item, all by this run's account and during the run:
    // from its start to now, or for a recovered run, to when that run finished.
    const changedOnlyByRun = async (id) => {
      const history = await api(`/issue/${id}/changelog?maxResults=100`);
      const from = Date.parse(run.state.started);
      const to = recover ? Date.parse(run.state.finished) : Date.now();
      return (
        history?.isLast === true &&
        history.values.length > 0 &&
        history.values.every(
          (change) =>
            change.author?.accountId === run.state.actor &&
            Date.parse(change.created) >= from &&
            Date.parse(change.created) <= to,
        )
      );
    };
    const markerProperty = (x) =>
      markerForms(markers.fixtureProperty)
        .map((key) => x?.properties?.[key])
        .find((value) => value !== undefined);
    // Jira stores a create's properties just after the work item itself, so the read right after
    // the create can come back without the marker. Only that read is repeated, a few times.
    const createdRead = async (entry) => {
      for (const wait of [250, 500, 1000, 2000, null]) {
        const x = await issueRead(entry.id);
        if (!entry.expected.propertyMarker || markerProperty(x) !== undefined || wait === null)
          return x;
        await new Promise((done) => setTimeout(done, wait));
      }
    };
    // Jira's history is empty while nothing has changed a field since the create.
    const unchangedSinceCreate = async (id) => {
      const history = await api(`/issue/${id}/changelog?maxResults=100`);
      return history?.isLast === true && history.values.length === 0;
    };
    const verifyIssue = async (entry, value) => {
      await verifyProject();
      const creating =
        run.state.status === 'active' && value === undefined && entry.observedFields === undefined;
      const x = value ?? (await (creating ? createdRead(entry) : issueRead(entry.id)));
      if (!x || x.id !== entry.id || x.fields.project.id !== project.id)
        throw Error('Work item identity mismatch');
      if (x.fields.summary !== entry.expected.summary) throw Error('Work item summary changed');
      same([...(x.fields.labels ?? [])].sort(), [...entry.expected.labels].sort());
      if (entry.expected.propertyMarker) same(markerProperty(x), { marker: entry.expected.marker });
      if (entry.expected.descriptionVariants) {
        if (
          !entry.expected.descriptionVariants.some((value) => {
            try {
              same(x.fields.description, value);
              return true;
            } catch {
              return false;
            }
          })
        )
          throw Error('Work item Description differs from every reviewed mutation intent');
      } else same(x.fields.description, entry.expected.description);
      if (entry.expected.customField) {
        const field = entry.expected.customField;
        try {
          same((await api(`/issue/${entry.id}?fields=${field.id}`)).fields[field.id], field.value);
        } catch (error) {
          // A save can land after its test stopped and before it recorded the new value. The field
          // is still the run's own while nothing but this run's account changed the work item.
          // A save the journey intended but never made leaves Jira's history empty: nothing has
          // changed the work item since the run created it, so the field holds its created value.
          // The other checks still apply to both.
          if (!(await changedOnlyByRun(entry.id)) && !(await unchangedSinceCreate(entry.id)))
            throw error;
        }
      }
      if (x.fields.subtasks?.length || x.fields.attachment?.length || x.fields.issuelinks?.length)
        throw Error('Work item acquired external dependents');
      const stable = JSON.parse(
        JSON.stringify(
          Object.fromEntries(
            [
              'issuetype',
              'status',
              'assignee',
              'reporter',
              'priority',
              'versions',
              'fixVersions',
              'components',
              'duedate',
              'timetracking',
            ].map((k) => [k, x.fields[k]]),
          ),
        ),
      );
      if (x.fields.worklog?.total) throw Error('Work item acquired work logs');
      if (entry.observedFields && entry.expected.statusIds) {
        // A journey that moves a fixture to another status records every status it may leave
        // behind before the change. Statuses compare by ID: renaming one changes its other fields.
        const { status: now, ...rest } = stable;
        const { status: then, ...baseline } = entry.observedFields;
        same(rest, baseline);
        if (![then?.id, now?.id].every((id) => entry.expected.statusIds.includes(id)))
          throw Error('Work item status differs from every recorded intent');
      } else if (entry.observedFields) same(stable, entry.observedFields);
      else {
        // Without a baseline from creation time, cleanup may take one only while the work item
        // still looks exactly as created: the checks above passed, this run's account reported it,
        // and it has the requested type. That covers one found by its unique run marker after a
        // lost create response, and one whose ID came from the create response but whose check at
        // creation never completed, while Jira's history shows no change since the create.
        // Anything else needs inspection.
        const asCreated = () =>
          x.fields.reporter?.accountId === run.state.actor &&
          x.fields.issuetype?.id === entry.expected.typeId;
        const untouched = async () =>
          entry.reconciled === true ||
          (entry.reconciled === undefined &&
            entry.prepareMs === undefined &&
            (await unchangedSinceCreate(entry.id)));
        if (run.state.status !== 'active' && !(asCreated() && (await untouched())))
          throw Error('Work item baseline missing; inspect ambiguous creation');
        entry.observedFields = stable;
        run.persist();
      }

      if ((await comments(api, entry.id)).length) throw Error('Work item acquired comments');
    };
    // Work items created through Jira's own Create form: the journey fills the form, which writes
    // nothing, so a failure there is a definitive rejection; then submits it, which may create.
    // The work item is found by the run marker in its summary. Jira's search can lag the create.
    const browserCreates = new Map();
    const createInBrowser = async (expected) => {
      const steps = browserCreates.get(expected.marker);
      if (!steps) throw Error('Browser create is not available');
      try {
        await steps.fill(expected.summary);
      } catch (error) {
        error.definitiveRejection = true;
        throw error;
      }
      await steps.submit();
      for (const wait of [1000, 2000, 4000, 8000, null]) {
        const found = (await allIssues(api, project.id)).filter(
          (x) => x.fields.summary === expected.summary,
        );
        if (found.length > 1) throw Error('More than one work item has the run marker');
        if (found.length) return found[0];
        if (wait === null) throw Error('The created work item was not found');
        await new Promise((done) => setTimeout(done, wait));
      }
    };
    const adapters = {
      issue: {
        create: (expected) =>
          expected.summaryMarker
            ? createInBrowser(expected)
            : api('/issue', 'POST', {
                fields: {
                  project: { id: project.id },
                  issuetype: {
                    id:
                      expected.typeId ??
                      project.issueTypes.find((t) => !t.subtask && t.name === 'Task')?.id,
                  },
                  summary: expected.summary,
                  ...(expected.propertyMarker ? {} : { labels: expected.labels }),
                  description: expected.description,
                },
                ...(expected.propertyMarker
                  ? {
                      properties: [
                        { key: markers.fixtureProperty, value: { marker: expected.marker } },
                      ],
                    }
                  : {}),
              }),
        read: issueRead,
        find: async (expected) => {
          const issues = await allIssues(api, project.id);
          if (expected.summaryMarker)
            return issues.filter((x) => x.fields.summary === expected.summary);
          if (!expected.propertyMarker)
            return issues.filter((x) => x.fields.labels?.includes(expected.marker));
          const found = [];
          for (const issue of issues.filter((x) => x.fields.summary === expected.summary))
            for (const key of markerForms(markers.fixtureProperty)) {
              const property = await api(`/issue/${issue.id}/properties/${key}`);
              if (property === null) continue;
              if (property.value?.marker === expected.marker) found.push(issue);
              break;
            }
          return found;
        },
        // No work item in the space has the create's summary or its marker label. The create sets
        // the marker in the same request, so a create that landed always leaves one of them.
        absent: async (expected) =>
          !(await allIssues(api, project.id)).some(
            (x) =>
              x.fields.summary === expected.summary || x.fields.labels?.includes(expected.marker),
          ),
        verify: verifyIssue,
        remove: async (entry) => {
          await verifyIssue(entry);
          await api(`/issue/${entry.id}?deleteSubtasks=false`, 'DELETE');
        },
      },
    };
    const projectAdmin = identity ? projectAdminFixture(api, identity, verifyProject) : null;
    if (projectAdmin) adapters['permission-grant'] = projectAdmin.adapter;
    if (recover) {
      const state = JSON.parse(readFileSync(path));
      if (
        state.app !== app ||
        state.site !== site() ||
        state.projectId !== project.id ||
        state.actor !== user.accountId ||
        state.runId !== recover ||
        state.schemaVersion !== 1 ||
        !Array.isArray(state.resources)
      )
        throw Error('Run ownership mismatch');
      for (const entry of state.resources) {
        if (
          !['issue', ...(identity ? ['permission-grant'] : [])].includes(entry.kind) ||
          (entry.id !== null && !/^[1-9][0-9]*$/.test(entry.id))
        )
          throw Error('Invalid journal resource');
        if (
          entry.kind === 'issue' &&
          (!isRunMarker(entry.expected.marker, recover) ||
            !(
              entry.expected.labels?.includes(entry.expected.marker) ||
              (entry.expected.typeId &&
                entry.expected.propertyMarker === entry.expected.marker &&
                entry.expected.labels?.length === 0) ||
              (entry.expected.typeId &&
                entry.expected.summaryMarker === true &&
                entry.expected.summary?.endsWith(` ${entry.expected.marker}`) &&
                entry.expected.labels?.length === 0)
            ))
        )
          throw Error('Invalid work item ownership marker');
        const statusIds = entry.kind === 'issue' ? entry.expected.statusIds : undefined;
        if (
          statusIds !== undefined &&
          !(
            Array.isArray(statusIds) &&
            statusIds.length >= 1 &&
            statusIds.length <= 10 &&
            statusIds.every((id) => typeof id === 'string' && /^[1-9]\d*$/.test(id))
          )
        )
          throw Error('Invalid work item status intent');
      }
      run = new FixtureRun({ state, save, adapters });
    } else {
      run = FixtureRun.create({ app, site: site(), projectId: project.id, save, adapters, runId });
      run.state.actor = user.accountId;
      run.state.fixtureProfile = profile;
      run.persist();
    }
    return {
      run,
      api,
      project,
      user,
      verifyProject,
      async grantProjectAdmin() {
        if (!projectAdmin)
          throw Error('Space administration fixture requires pinned identity profile');
        return run.create('permission-grant', await projectAdmin.intent());
      },
      async issue(summary, labels = []) {
        // Resolve the type before intent is recorded: a space without it is a plain error,
        // not an uncertain create.
        const task = project.issueTypes.find((t) => !t.subtask && t.name === 'Task');
        if (!task) throw Error('The fixture space has no Task work type.');
        const marker = markers.runMarker(runId, run.state.resources.length);
        return run.create('issue', {
          summary,
          labels: [...labels, marker],
          description: adf(markers.disposableIssue(marker)),
          marker,
          typeId: task.id,
        });
      },
      // A work item of a chosen type, marked by a work item property instead of a label, with
      // `body` plus the run marker as its Description.
      async propertyIssue(summary, body, typeId) {
        if (typeof typeId !== 'string' || !/^[1-9]\d*$/.test(typeId))
          throw Error('Read the configured work type before creating a fixture.');
        const type = project.issueTypes.find((t) => t.id === typeId && !t.subtask);
        if (!type) throw Error('Configured work type is unavailable in the owned space.');
        const marker = markers.runMarker(runId, run.state.resources.length);
        return run.create('issue', {
          summary,
          labels: [],
          propertyMarker: marker,
          description: adf(`${body}\nSynthetic ${marker}`),
          marker,
          typeId: type.id,
        });
      },
      // A work item of a chosen type created through Jira's own Create form, which sets no labels
      // or properties: the run marker ends its summary and the Description stays empty.
      // `fill(summary)` opens and fills the form without submitting it; `submit()` makes the one
      // click that may create the work item, and nothing may repeat it.
      async browserIssue(summary, typeId, { fill, submit } = {}) {
        if (typeof typeId !== 'string' || !/^[1-9]\d*$/.test(typeId))
          throw Error('Read the work type before creating a fixture.');
        const type = project.issueTypes.find((t) => t.id === typeId && !t.subtask);
        if (!type) throw Error('The work type is unavailable in the owned space.');
        if (typeof fill !== 'function' || typeof submit !== 'function')
          throw Error('A browser create needs its fill and submit steps.');
        const marker = markers.runMarker(runId, run.state.resources.length);
        browserCreates.set(marker, { fill, submit });
        try {
          return await run.create('issue', {
            summary: `${summary} ${marker}`,
            labels: [],
            summaryMarker: true,
            description: null,
            marker,
            typeId: type.id,
          });
        } finally {
          browserCreates.delete(marker);
        }
      },
      async cleanup() {
        try {
          // Only a recovery, run after the journal's run finished, may close a create that never
          // landed; a run's own cleanup right after a lost response can't tell yet.
          await run.cleanup({ concurrency: 1, ...(recover ? { absentAfterMs: 300_000 } : {}) });
        } finally {
          if (run.state.status === 'clean') unlinkSync(lock);
        }
      },
      async releaseForRecovery() {
        unlinkSync(lock);
      },
    };
  } catch (e) {
    unlinkSync(lock);
    throw e;
  }
}
