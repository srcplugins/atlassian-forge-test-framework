import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/config.mjs';
import { lane } from '../src/jira/commands.mjs';

// A local lane shares the suite's fixture spaces, so it must not start while a suite holds the
// site, and a suite's own lanes pass its lease ID instead of waiting on themselves.
test('a lane refuses to start while another run holds the site lease, naming it', async () => {
  const seen = [];
  await assert.rejects(
    () =>
      lane('features', [], {
        holder: async (env) => {
          seen.push(env.E2E_LANE);
          return 'org/plugin run 7';
        },
      }),
    /^Error: The site is in use by org\/plugin run 7; run the lane when it finishes\.$/,
  );
  assert.deepEqual(seen, ['features']);
});

test('an unknown lane is refused before the lease is read', async () => {
  await assert.rejects(
    () => lane('nope', [], { holder: assert.fail }),
    /Usage: forge-test lane <features\|compatibility>/,
  );
});
