// This repository is public. Its tracked files carry no agent instructions and name no
// Atlassian site other than the documented examples: real sites come from private
// configuration (docs/configuration.md). Findings name the file, never the value.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const agentFile =
  /(?:^|\/)(?:CLAUDE\.md|AGENTS\.md|\.claude\/|\.codex\/|\.cursor\/|\.cursorrules$|\.github\/copilot-instructions\.md$)/;
const siteHost = /\b([a-z0-9-]+)\.atlassian\.net\b/gi;
// The docs use your-site and your-second-site; tests use example and <name>-example.
const exampleSite = /^(?:your-site|your-second-site|example|[a-z0-9-]+-example)$/;

/** Findings for one tracked file, from its path and text. */
export function publicRepositoryFindingsIn(file, text) {
  const findings = [];
  if (agentFile.test(file)) findings.push(`${file}: agent instructions must not be committed`);
  for (const [, name] of text.matchAll(siteHost))
    if (!exampleSite.test(name.toLowerCase())) {
      findings.push(`${file}: names an Atlassian site that isn't an example; use configuration`);
      break;
    }
  return findings;
}

/** Findings for every file git tracks in a directory. Without git's list, the check fails. */
export function publicRepositoryFindings(directory) {
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: directory, encoding: 'utf8' });
  if (tracked.status !== 0) return ['git ls-files failed: cannot list the tracked files'];
  return tracked.stdout
    .split('\0')
    .filter((file) => file && existsSync(join(directory, file)))
    .flatMap((file) =>
      publicRepositoryFindingsIn(file, readFileSync(join(directory, file), 'utf8')),
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const findings = publicRepositoryFindings(resolve(process.argv[2] ?? '.'));
  for (const finding of findings) console.error(finding);
  if (findings.length) process.exitCode = 1;
  else console.log('Public repository check passed.');
}
