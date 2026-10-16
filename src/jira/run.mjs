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

// Fixture profiles select the owned project a run writes to. `standard` is the fixture app's own
// project and `identity` the pinned identity project, both company-managed. A consumer registers
// further profiles (registerProfile) before opening or recovering such a run: { project(app) ->
// key, marker(app) -> project description marker, allow({ app, host }) throws when not allowed,
// missing: message when the marked project is absent, style?: 'classic' (default) or 'next-gen'
// for a team-managed project }.
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
  // The identity profile uses the pinned identity project, validated below; the lane that
  // selects it owns its app-specific eligibility checks.
  if (!known(profile)) throw Error('Unsupported fixture profile');
  if (recover && !/^[0-9a-f-]{36}$/.test(recover)) throw Error('Invalid run ID');
  // Recovery resolves the saved profile before any project operation; no caller-selected alternate target.
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
    throw Error(extension?.missing ?? 'Owned isolated fixture project required. Run prepare.');
  const user = await api('/myself');
  if (!user?.accountId) throw Error('Authenticated fixture identity required');
  const verifyIdentityProject = async () => {
    if (
      identity &&
      (project.id !== identity.project.id ||
        user.accountId !== identity.actors.owner ||
        String((await api(`/project/${project.id}/permissionscheme`))?.id) !== identity.scheme.id)
    )
      throw Error('Identity fixture project, scheme or setup actor mismatch');
  };
  await verifyIdentityProject();
  await checkFixturePermissions(api, project.id);
  mkdirSync(directory, { recursive: true });
  const runId = recover ?? randomUUID();
  if (!/^[0-9a-f-]{36}$/.test(runId)) throw Error('Invalid run ID');
  const lock = `${directory}/${project.id}.lock`;
  if (existsSync(lock)) {
    const holder = JSON.parse(readFileSync(lock));
    if (!recover || holder.runId !== recover) throw Error('Fixture project is locked');
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
        throw Error('Project ownership changed');
      await verifyIdentityProject();
    };
    const issueRead = (id) =>
      api(
        `/issue/${id}?fields=summary,labels,description,project,issuetype,subtasks,attachment,issuelinks,status,assignee,reporter,priority,versions,fixVersions,components,duedate,timetracking,worklog&properties=${markerForms(markers.fixtureProperty).join(',')}`,
      );
    // Jira's history shows changes to the issue, all by this run's account and during the run:
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
    const verifyIssue = async (entry, value) => {
      await verifyProject();
      const x = value ?? (await issueRead(entry.id));
      if (!x || x.id !== entry.id || x.fields.project.id !== project.id)
        throw Error('Issue identity mismatch');
      if (x.fields.summary !== entry.expected.summary) throw Error('Issue summary changed');
      same([...(x.fields.labels ?? [])].sort(), [...entry.expected.labels].sort());
      if (entry.expected.propertyMarker)
        same(
          markerForms(markers.fixtureProperty)
            .map((key) => x.properties?.[key])
            .find((value) => value !== undefined),
          { marker: entry.expected.marker },
        );
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
          throw Error('Issue Description differs from every reviewed mutation intent');
      } else same(x.fields.description, entry.expected.description);
      if (entry.expected.customField) {
        const field = entry.expected.customField;
        try {
          same((await api(`/issue/${entry.id}?fields=${field.id}`)).fields[field.id], field.value);
        } catch (error) {
          // A save can land after its test stopped and before it recorded the new value. The
          // field is still the run's own while nothing but this run's account changed the issue.
          if (!(await changedOnlyByRun(entry.id))) throw error;
        }
      }
      if (x.fields.subtasks?.length || x.fields.attachment?.length || x.fields.issuelinks?.length)
        throw Error('Issue acquired external dependents');
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
      if (x.fields.worklog?.total) throw Error('Issue acquired work logs');
      if (entry.observedFields) same(stable, entry.observedFields);
      else {
        // Without a baseline from creation time, cleanup may take one only for an issue found by
        // its unique run marker after a lost create response, and only while it still looks
        // exactly as created: the checks above passed, this run's account reported it, and it
        // has the requested type. Anything else needs inspection.
        const untouchedReconciled =
          entry.reconciled === true &&
          x.fields.reporter?.accountId === run.state.actor &&
          x.fields.issuetype?.id === entry.expected.typeId;
        if (run.state.status !== 'active' && !untouchedReconciled)
          throw Error('Issue baseline missing; inspect ambiguous creation');
        entry.observedFields = stable;
        run.persist();
      }

      if ((await comments(api, entry.id)).length) throw Error('Issue acquired comments');
    };
    const adapters = {
      issue: {
        create: (expected) =>
          api('/issue', 'POST', {
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
                entry.expected.labels?.length === 0)
            ))
        )
          throw Error('Invalid issue ownership marker');
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
          throw Error('Project administration fixture requires pinned identity profile');
        return run.create('permission-grant', await projectAdmin.intent());
      },
      async issue(summary, labels = []) {
        // Resolve the type before intent is recorded: a project without it is a plain error,
        // not an uncertain create.
        const task = project.issueTypes.find((t) => !t.subtask && t.name === 'Task');
        if (!task) throw Error('The fixture project has no Task issue type.');
        const marker = markers.runMarker(runId, run.state.resources.length);
        return run.create('issue', {
          summary,
          labels: [...labels, marker],
          description: adf(markers.disposableIssue(marker)),
          marker,
          typeId: task.id,
        });
      },
      // An issue of a chosen type, marked by an issue property instead of a label, with
      // `body` plus the run marker as its Description.
      async propertyIssue(summary, body, typeId) {
        if (typeof typeId !== 'string' || !/^[1-9]\d*$/.test(typeId))
          throw Error('Read the configured issue type before creating a fixture.');
        const type = project.issueTypes.find((t) => t.id === typeId && !t.subtask);
        if (!type) throw Error('Configured issue type is unavailable in the owned project.');
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
      async cleanup() {
        try {
          await run.cleanup({ concurrency: 1 });
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
