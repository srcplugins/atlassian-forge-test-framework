import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicRepositoryFindingsIn } from '../scripts/check-public.mjs';

// Hosts are assembled at run time, so this file names no site itself.
const host = (name) => [name, 'atlassian', 'net'].join('.');
const script = fileURLToPath(new URL('../scripts/check-public.mjs', import.meta.url));
const siteFinding = (file) =>
  `${file}: names an Atlassian site that isn't an example; use configuration`;
// A clean git environment, so a caller's GIT_DIR or index can't stand in for the test repository.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), 'public-check-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('agent instruction files are refused wherever they are tracked', () => {
  for (const file of [
    'CLAUDE.md',
    'docs/AGENTS.md',
    '.claude/settings.json',
    '.codex/config.toml',
    '.cursor/rules/style.mdc',
    '.cursorrules',
    '.github/copilot-instructions.md',
  ])
    assert.deepEqual(publicRepositoryFindingsIn(file, ''), [
      `${file}: agent instructions must not be committed`,
    ]);
  for (const file of ['README.md', 'src/agents.mjs', 'tests/cursor.test.mjs', '.github/ci.yml'])
    assert.deepEqual(publicRepositoryFindingsIn(file, ''), []);
});

test('only example site names pass, and a finding names the file but not the site', () => {
  for (const name of ['your-site', 'your-second-site', 'example', 'primary-example', 'YOUR-SITE'])
    assert.deepEqual(publicRepositoryFindingsIn('docs/a.md', `https://${host(name)}/jira`), []);
  assert.deepEqual(publicRepositoryFindingsIn('docs/a.md', `${host('<owned-site>')}`), []);
  for (const name of ['acme-test', 'examples', 'example-corp', 'my-company']) {
    const text = `Open ${host('your-site')}, then ${host(name)} and ${host(`${name}-two`)}.`;
    assert.deepEqual(publicRepositoryFindingsIn('docs/a.md', text), [siteFinding('docs/a.md')]);
    assert.ok(!siteFinding('docs/a.md').includes(name));
  }
});

test('the command checks only tracked files and exits 1 on a finding', (t) => {
  const directory = scratch(t);
  const git = (...args) =>
    assert.equal(spawnSync('git', args, { cwd: directory, env }).status, 0, args.join(' '));
  const check = () => spawnSync(process.execPath, [script, directory], { env, encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(join(directory, 'README.md'), `See ${host('your-site')}.\n`);
  writeFileSync(join(directory, 'notes.md'), `See ${host('acme-test')}.\n`);
  mkdirSync(join(directory, '.claude'));
  writeFileSync(join(directory, '.claude', 'settings.json'), '{}\n');
  git('add', 'README.md');
  let result = check();
  assert.equal(result.status, 0, result.stderr);
  // -f: a global ignore file may exclude agent files.
  git('add', '-f', 'notes.md', '.claude/settings.json');
  result = check();
  assert.equal(result.status, 1);
  assert.deepEqual(result.stderr.trim().split('\n').sort(), [
    '.claude/settings.json: agent instructions must not be committed',
    siteFinding('notes.md'),
  ]);
});

test('the command fails when git cannot list the tracked files', (t) => {
  const directory = scratch(t);
  const result = spawnSync(process.execPath, [script, directory], {
    env: { ...env, GIT_CEILING_DIRECTORIES: tmpdir() },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot list the tracked files/);
});
