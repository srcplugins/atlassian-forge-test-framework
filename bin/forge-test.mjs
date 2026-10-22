#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installArguments, installOptions, installedOn } from '../src/core/forge-install.mjs';
import { listSuite, selectSteps } from '../src/core/suite.mjs';
import {
  cleanup,
  doctor,
  lane,
  login,
  maskValues,
  prepare,
  preflight,
  restore,
  secrets,
  suite,
} from '../src/jira/commands.mjs';

// forge-test: hosted acceptance commands for a Forge app repository. The repository's optional
// forge-test.mjs module supplies its suites, registers fixture profiles (registerProfile) and
// names its guarded Forge CLI command. Usage: docs/commands.md.
const usage = `Usage: forge-test <command>
  doctor                         Check the configured Jira account (read-only)
  preflight <host>               Inventory an owned site (read-only)
  login [profile]                Save a browser session after a manual sign-in
  prepare                        Create or verify the marked fixture spaces
  cleanup <fixture-app> <run>    Guarded cleanup of one journaled run
  lane <lane> [--config f] [-- args]  Run a Playwright lane (features, compatibility)
  suite <name> [--only a,b] [--list]  Run a suite from forge-test.mjs (--only: its prerequisites
                                 and the steps whose names contain a term)
  install [--role r] [-e env]    Install or upgrade the app through the module's Forge command
  secrets --repo o/r --env e [--profiles a,b] [--dry-run]   Copy state into GitHub secrets
  restore                        Write sessions from CI secrets into the private state layout
  mask                           Print ::add-mask:: lines for owned hosts, IDs and fixture space keys`;

async function consumer() {
  const file = resolve('forge-test.mjs');
  return existsSync(file) ? import(pathToFileURL(file).href) : {};
}
function option(args, name) {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}

const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case 'doctor':
      await doctor();
      break;
    case 'preflight':
      await preflight(args[0]);
      break;
    case 'login':
      await login(args[0]);
      break;
    case 'prepare':
      await prepare();
      break;
    case 'cleanup':
      await consumer();
      await cleanup(args[0], args[1]);
      break;
    case 'lane': {
      const split = args.indexOf('--');
      const own = split < 0 ? args : args.slice(0, split);
      const configFile = option(own, '--config') ?? 'playwright.config.mjs';
      process.exitCode = await lane(own[0], split < 0 ? [] : args.slice(split + 1), { configFile });
      break;
    }
    case 'suite': {
      const { suites = {} } = await consumer();
      if (!suites[args[0]])
        throw Error(`No suite ${args[0]}; forge-test.mjs defines: ${Object.keys(suites)}`);
      const only = option(args, '--only');
      const steps = selectSteps(suites[args[0]], only);
      const title = `${args[0]} suite${only ? ` (only ${only})` : ''}`;
      if (args.includes('--list')) listSuite(steps);
      else process.exitCode = (await suite(title, steps)) ? 0 : 1;
      break;
    }
    case 'install': {
      const { forge } = await consumer();
      if (!Array.isArray(forge) || !forge.length)
        throw Error('forge-test.mjs must export forge: the guarded Forge CLI command.');
      const options = installOptions(args);
      // Read failures are not evidence that an installation is absent: refuse the write.
      const listed = spawnSync(forge[0], [...forge.slice(1), 'install', 'list', '--json'], {
        encoding: 'utf8',
      });
      const start = listed.stdout?.indexOf('[') ?? -1;
      if (listed.status !== 0 || start < 0)
        throw Error('Installation inventory unavailable; install refused.');
      const installed = installedOn(
        JSON.parse(listed.stdout.slice(start)),
        options.site,
        options.environment,
      );
      const result = spawnSync(
        forge[0],
        [...forge.slice(1), ...installArguments(options, installed)],
        {
          stdio: 'inherit',
        },
      );
      process.exitCode = result.status ?? 1;
      break;
    }
    case 'secrets':
      secrets({
        repo: option(args, '--repo'),
        environment: option(args, '--env'),
        profiles: (option(args, '--profiles') ?? 'admin').split(','),
        dryRun: args.includes('--dry-run'),
      });
      break;
    case 'restore':
      restore();
      break;
    case 'mask':
      for (const value of maskValues()) console.log(`::add-mask::${value}`);
      break;
    default:
      console.error(usage);
      process.exitCode = command ? 2 : 0;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
