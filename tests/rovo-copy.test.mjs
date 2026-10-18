import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { copyAgentProfile } from '../src/core/rovo.mjs';
// Offline polling: tight intervals, but a generous budget so a loaded machine can't
// fail the passing cases; only the timeout case uses the short budget. The hosted
// journey keeps the default five-second wait.
const poll = { timeout: 5000, intervals: [1] };
const expire = { timeout: 50, intervals: [1] };
const profile =
  '/o/12345678-1234-1234-1234-123456789abc/people/agent/12345678-1234-1234-1234-123456789abc';
function clipboardFixture(result, delay = 0) {
  let value = `https://home.atlassian.com${profile}`;
  let reads = 0;
  let clicks = 0;
  const clipboard = {
    writeText: async (text) => {
      value = text;
    },
    readText: async () => {
      reads++;
      if (reads > delay && result !== null) value = result;
      return value;
    },
  };
  return {
    page: {
      evaluate: (fn, arg) => runInNewContext(`(${fn})(arg)`, { navigator: { clipboard }, arg }),
    },
    button: {
      click: async () => {
        clicks++;
        assert.match(value, /^forge-test-copy-pending:/);
      },
    },
    counts: () => ({ reads, clicks }),
  };
}
test('agent copy waits for a fresh clipboard write even when the previous link was valid', async () => {
  const fixture = clipboardFixture(
    `https://home.atlassian.com${profile}?cloudId=owned&xpis=tracking`,
    2,
  );
  assert.equal(await copyAgentProfile(fixture.page, fixture.button, poll), profile);
  assert.deepEqual(fixture.counts(), { reads: 3, clicks: 1 });
});
test('agent copy rejects foreign hosts and malformed profile links', async () => {
  for (const value of [
    'https://example.com' + profile,
    'https://home.atlassian.com/other',
    `https://home.atlassian.com${profile}/extra`,
  ]) {
    const fixture = clipboardFixture(value);
    await assert.rejects(copyAgentProfile(fixture.page, fixture.button, poll));
    assert.equal(fixture.counts().clicks, 1);
  }
});
test('agent copy times out without retrying the click or accepting the old clipboard', async () => {
  const fixture = clipboardFixture(null);
  await assert.rejects(
    copyAgentProfile(fixture.page, fixture.button, expire),
    /Copy link did not complete/,
  );
  assert.equal(fixture.counts().clicks, 1);
});
