import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './support/config.mjs';
import { definePlaywrightConfig } from '../src/core/lanes.mjs';
import { defaultAppLoadLimit, frameStage, guardTest } from '../src/core/page-guard.mjs';
import { appReady, pageGuard, readinessStages } from '../src/jira/guard.mjs';

const appId = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';
const otherApp = 'ffeeddcc-bbaa-4998-8716-5f4e3d2c1b0a';
const frameSrc = (id) => `https://cdn.example.net/${id}/resources/index.html`;

// A browser context double: the guard's binding, and its init script run as Playwright runs it
// (serialized, so it can use nothing outside itself) in a page double with a manual clock.
async function harness(options = {}) {
  const annotations = [];
  const context = {};
  context.exposeBinding = async (name, fn) => {
    context.binding = { name, fn };
  };
  context.addInitScript = async (script) => {
    assert.equal(typeof script, 'string');
    context.script = script;
  };
  const guard = await pageGuard(context, {
    appIds: [appId],
    annotate: (type, description) => annotations.push({ type, description }),
    ...options,
  });
  const page = ({ top = true } = {}) => {
    const p = { alerts: [], frames: [], now: 0, loads: [] };
    const window = {
      addEventListener: (type, fn, capture) => {
        assert.deepEqual([type, capture], ['load', true]);
        p.loads.push(fn);
      },
    };
    window.top = top ? window : {};
    window[context.binding.name] = async (event) => context.binding.fn({}, event);
    const document = {
      querySelectorAll: (selector) =>
        ({ '[role="alert"]': p.alerts, 'iframe[src]': p.frames })[selector] ?? [],
    };
    const setInterval = (fn, ms) => {
      assert.equal(ms, 200);
      p.tick = fn;
    };
    new Function(
      'window',
      'document',
      'getComputedStyle',
      'setInterval',
      'performance',
      context.script,
    )(window, document, (el) => ({ visibility: el.visibility }), setInterval, {
      now: () => p.now,
    });
    // Playwright's page.evaluate, run against this page's window.
    p.context = () => context;
    p.evaluate = async (fn, arg) => new Function('window', `return (${fn})`)(window)(arg);
    // The browser's load event for a frame's document.
    p.load = (frame) => {
      for (const fn of p.loads) fn({ target: frame });
    };
    // Advances the clock in 200 ms steps, as the page's interval would.
    p.advance = async (ms) => {
      for (let t = 0; t < ms; t += 200) {
        p.now += 200;
        p.tick?.();
      }
      await new Promise((done) => setImmediate(done));
    };
    p.flag = (title, description = '') => {
      const alert = {
        innerText: `${title}\n${description}`,
        querySelector: (s) => (s.startsWith('h1') ? { innerText: title } : null),
      };
      p.alerts.push(alert);
      return alert;
    };
    // An app frame in Forge's wrapper. A loading app has Forge's skeleton beside a hidden frame;
    // a loaded Custom UI app's frame is visible, and a loaded UI Kit app renders `content` beside
    // a frame that stays hidden. Its document has loaded unless `loaded` is false.
    p.frame = (id, { title = 'Agent Prompts', displayed = true, loaded = true } = {}) => {
      const box = (height, matches = () => false) => ({
        contains: () => false,
        matches,
        getBoundingClientRect: () => ({ height }),
      });
      const skeleton = box(16, (s) => s === '[data-testid^="forgeskeleton"]');
      const content = box(300);
      const container = { ...box(0), contains: (el) => el === frame };
      const wrapper = {
        get children() {
          return [
            ...(frame.skeleton ? [skeleton] : []),
            ...(frame.content ? [content] : []),
            container,
          ];
        },
        querySelector: (s) =>
          s === '[data-testid^="forgeskeleton"]' && frame.skeleton ? skeleton : null,
      };
      const frame = {
        tagName: 'IFRAME',
        src: frameSrc(id),
        title,
        visibility: 'hidden',
        skeleton: true,
        content: false,
        isConnected: true,
        displayed,
        getClientRects: () => (frame.displayed ? [{}] : []),
        closest: (s) =>
          ({
            '#forge-ui-height-observer-wrapper': wrapper,
            '[data-testid="hosted-resources-iframe-container"]': container,
          })[s] ?? null,
      };
      p.frames.push(frame);
      if (loaded) p.load(frame);
      return frame;
    };
    return p;
  };
  return { guard, annotations, page };
}

test('an undeclared error flag fails the test, naming the flag', async () => {
  const { guard, page } = await harness();
  const p = page();
  p.flag('Created Story with exceptions', "We couldn't save the value of the Agent Prompts field.");
  await p.advance(200);
  assert.throws(
    () => guard.check(),
    (error) =>
      error.category === 'page-guard' &&
      error.message.includes('Created Story with exceptions') &&
      error.message.includes("couldn't save the value of the Agent Prompts field"),
  );
});

test('each kind of Jira error flag is an error; a success flag is not', async () => {
  for (const [title, description, error] of [
    ['Something went wrong', 'Try again later.', true],
    ["We couldn't load the work item", '', true],
    ['Error', 'The field could not be updated.', true],
    ['Created Task KEY-1', 'View Task · Copy link', false],
    ['Changes saved', '', false],
  ]) {
    const { guard, page } = await harness();
    const p = page();
    p.flag(title, description);
    await p.advance(200);
    assert.equal(guard.flags.length, 1);
    assert.equal(guard.flags[0].title, title);
    assert.equal(guard.flags[0].error, error, title);
    if (error) assert.throws(() => guard.check(), title);
    else assert.doesNotThrow(() => guard.check(), title);
  }
});

test('a declared flag passes, by string, regular expression or allowFlag', async () => {
  for (const declare of [
    { expectedFlags: ['Created Story with exceptions'] },
    { expectedFlags: [/with exceptions/] },
    { allow: "couldn't save the value of the Agent Prompts field" },
  ]) {
    const { guard, page } = await harness({ expectedFlags: declare.expectedFlags ?? [] });
    if (declare.allow) guard.allowFlag(declare.allow);
    const p = page();
    p.flag(
      'Created Story with exceptions',
      "We couldn't save the value of the Agent Prompts field.",
    );
    p.flag('Something went wrong', '');
    await p.advance(200);
    // Only the declared flag is exempt; the other error flag still fails.
    assert.throws(
      () => guard.check(),
      (error) =>
        error.message.includes('Something went wrong') && !error.message.includes('exceptions'),
    );
  }
});

test('a flag is reported once per text, and again when its text changes', async () => {
  const { guard, annotations, page } = await harness();
  const p = page();
  const alert = p.flag('Created Task KEY-1', 'View Task');
  await p.advance(1000);
  assert.equal(guard.flags.length, 1);
  alert.innerText += '\nCopy link';
  await p.advance(1000);
  assert.equal(guard.flags.length, 2);
  assert.deepEqual(
    annotations.map((a) => a.type),
    ['jira-flag', 'jira-flag'],
  );
});

test('an alert without a heading, or in a frame, is not a flag', async () => {
  const { guard, page } = await harness();
  const p = page();
  p.alerts.push({ innerText: 'Something went wrong', querySelector: () => null });
  await p.advance(400);
  const nested = page({ top: false });
  nested.flag('Something went wrong');
  await nested.advance(400);
  assert.equal(nested.tick, undefined);
  assert.deepEqual(guard.flags, []);
  assert.doesNotThrow(() => guard.check());
});

test('an app frame still behind the placeholder after the limit fails the test', async () => {
  const { guard, page } = await harness({ appLoadLimit: 15_000 });
  const p = page();
  p.frame(appId);
  await p.advance(200); // The page first sees the frame.
  await p.advance(14_800);
  assert.doesNotThrow(() => guard.check());
  await p.advance(400);
  assert.throws(
    () => guard.check(),
    (error) =>
      error.category === 'page-guard' &&
      error.stage === 'placeholder' &&
      error.message ===
        `The app frame "Agent Prompts" was not ready after 15 s: it stayed behind Jira's loading placeholder.`,
  );
});

test('a Custom UI frame that loads within the limit passes and its load time is recorded', async () => {
  const { guard, annotations, page } = await harness({ appLoadLimit: 15_000 });
  const p = page();
  const frame = p.frame(appId);
  await p.advance(1800);
  frame.skeleton = false;
  frame.visibility = 'visible';
  await p.advance(30_000);
  assert.doesNotThrow(() => guard.check());
  assert.deepEqual(annotations, [{ type: 'app-frame-ms', description: '1800' }]);
});

test('a UI Kit app that renders beside its hidden frame has loaded', async () => {
  const { guard, annotations, page } = await harness({ appLoadLimit: 15_000 });
  const p = page();
  const frame = p.frame(appId);
  await p.advance(1000);
  frame.skeleton = false;
  frame.content = true;
  await p.advance(30_000);
  assert.doesNotThrow(() => guard.check());
  assert.deepEqual(annotations, [{ type: 'app-frame-ms', description: '1000' }]);
});

test('without the skeleton, a hidden frame with nothing rendered beside it is still loading', async () => {
  for (const [change, stage, text] of [
    [(frame) => (frame.skeleton = false), 'root', /never rendered its root/],
    [(frame) => (frame.visibility = 'visible'), 'placeholder', /behind Jira's loading placeholder/],
  ]) {
    const { guard, page } = await harness({ appLoadLimit: 15_000 });
    const p = page();
    change(p.frame(appId));
    await p.advance(15_400);
    assert.throws(
      () => guard.check(),
      (error) => error.stage === stage && text.test(error.message),
    );
  }
});

test('an undisplayed frame, another app’s frame or a removed frame never fails', async () => {
  const { guard, annotations, page } = await harness({ appLoadLimit: 1000 });
  const p = page();
  const collapsed = p.frame(appId, { displayed: false });
  p.frame(otherApp);
  const removed = p.frame(appId);
  await p.advance(400);
  removed.isConnected = false;
  p.frames.splice(p.frames.indexOf(removed), 1);
  await p.advance(5000);
  assert.doesNotThrow(() => guard.check());
  // Once displayed, the collapsed frame's wait starts then.
  collapsed.displayed = true;
  await p.advance(800);
  assert.doesNotThrow(() => guard.check());
  await p.advance(400);
  assert.throws(() => guard.check());
  // Only the collapsed frame, once displayed, was ever not ready.
  assert.deepEqual(annotations, [{ type: 'app-readiness', description: 'placeholder' }]);
});

test('each problem is reported once', async () => {
  const { guard, page } = await harness();
  const p = page();
  p.flag('Something went wrong');
  await p.advance(200);
  assert.throws(() => guard.check());
  assert.doesNotThrow(() => guard.check());
  p.flag('Error', 'Another failure.');
  await p.advance(200);
  assert.throws(
    () => guard.check(),
    (error) => error.message === 'Jira showed the error flag "Error Another failure.".',
  );
});

test("Create's outcome: a success flag returns, exceptions fail at once, none fails", async () => {
  {
    const { guard, page } = await harness();
    const p = page();
    p.flag('Created Task KEY-1', 'View Task');
    await p.advance(200);
    await guard.createOutcome({ since: 0, timeout: 100 });
  }
  {
    const { guard, page } = await harness();
    const p = page();
    const since = Date.now();
    const outcome = guard.createOutcome({ since, timeout: 5000 });
    p.flag('Created Story with exceptions', "We couldn't save the value of the X field.");
    await p.advance(200);
    await assert.rejects(outcome, (error) => error.category === 'page-guard');
  }
  {
    const { guard, page } = await harness();
    const p = page();
    p.flag('Created Task KEY-1');
    await p.advance(200);
    // A flag from before the submit isn't this create's outcome.
    await assert.rejects(guard.createOutcome({ since: Date.now() + 1, timeout: 300 }), {
      message: 'Jira showed no Create outcome flag within 0.3 s.',
    });
  }
});

test('the options are checked', async () => {
  await assert.rejects(harness({ expectedFlags: [42] }), /string or a regular expression/);
  await assert.rejects(harness({ appLoadLimit: 0 }), /positive number/);
  // The default bound is the default assertion timeout of the framework's Playwright lanes.
  assert.equal(defaultAppLoadLimit, 30_000);
  assert.equal(definePlaywrightConfig({ testDir: 't' }, {}).expect.timeout, defaultAppLoadLimit);
  const { guard } = await harness();
  assert.throws(() => guard.allowFlag({}), /string or a regular expression/);
});

test('a frame’s stage is the first readiness stage it hasn’t passed', () => {
  assert.deepEqual(readinessStages, ['attached', 'document', 'placeholder', 'root']);
  const seen = {
    displayed: true,
    loaded: true,
    placeholder: false,
    visible: false,
    rendered: false,
  };
  for (const [observed, stage] of [
    [{ displayed: false }, 'undisplayed'],
    [{ loaded: false, placeholder: true }, 'document'],
    [{ placeholder: true }, 'placeholder'],
    [{ placeholder: true, visible: true }, 'placeholder'],
    [{}, 'root'],
    [{ loaded: false }, 'document'],
    [{ visible: true }, 'ready'],
    [{ rendered: true }, 'ready'],
    // A frame whose load event was missed but which shows its root is ready all the same.
    [{ loaded: false, visible: true }, 'ready'],
  ])
    assert.equal(frameStage({ ...seen, ...observed }), stage, JSON.stringify(observed));
});

test('a stuck frame names the stage it failed at, in the error, the report and the guard', async () => {
  for (const [setup, stage, text] of [
    [(p) => p.frame(appId, { loaded: false }), 'document', "its document didn't finish loading"],
    [(p) => p.frame(appId), 'placeholder', "it stayed behind Jira's loading placeholder"],
    [
      (p) => (p.frame(appId).skeleton = false),
      'root',
      'the app never rendered its root (the frame stayed hidden with nothing rendered beside it)',
    ],
  ]) {
    const { guard, annotations, page } = await harness({ appLoadLimit: 2000 });
    const p = page();
    setup(p);
    await p.advance(2400);
    assert.throws(
      () => guard.check(),
      (error) =>
        error.stage === stage &&
        error.message === `The app frame "Agent Prompts" was not ready after 2 s: ${text}.`,
    );
    assert.deepEqual(annotations, [{ type: 'app-readiness', description: stage }]);
    assert.deepEqual(
      guard.readiness.map((r) => [r.title, r.stage]),
      [['Agent Prompts', stage]],
    );
  }
});

test('a frame that loads again for a new address is waiting for its document again', async () => {
  const { guard, page } = await harness({ appLoadLimit: 2000 });
  const p = page();
  const frame = p.frame(appId);
  await p.advance(400);
  frame.src = `${frame.src}?route=other`;
  await p.advance(2400);
  assert.throws(
    () => guard.check(),
    (error) => error.stage === 'document',
  );
});

test('a frame that is ready after the limit still records its load time', async () => {
  const { guard, annotations, page } = await harness({ appLoadLimit: 2000 });
  const p = page();
  const frame = p.frame(appId);
  await p.advance(3000);
  frame.skeleton = false;
  frame.visibility = 'visible';
  await p.advance(200);
  assert.throws(() => guard.check(), /behind Jira's loading placeholder/);
  assert.deepEqual(annotations, [
    { type: 'app-readiness', description: 'placeholder' },
    { type: 'app-frame-ms', description: '3000' }, // Since the page first saw it.
  ]);
});

test('appReady resolves once every displayed app frame on the page is ready', async () => {
  const { page } = await harness({ appLoadLimit: 5000 });
  const p = page();
  const frame = p.frame(appId);
  p.frame(appId, { displayed: false });
  await p.advance(200);
  const ready = appReady(p, { timeout: 2000 });
  await p.advance(600);
  frame.skeleton = false;
  frame.content = true;
  await p.advance(200);
  assert.deepEqual(
    (await ready).map((f) => [f.title, f.stage, f.ms]),
    [['Agent Prompts', 'ready', 800]],
  );
});

test('appReady throws the stage the slowest frame hasn’t passed, once', async () => {
  const { guard, annotations, page } = await harness({ appLoadLimit: 60_000 });
  const p = page();
  p.frame(appId, { title: 'Settings' }).skeleton = false; // Waiting for its root.
  p.frame(appId, { title: 'Field', loaded: false }); // Waiting for its document.
  await p.advance(200);
  await assert.rejects(appReady(p, { timeout: 300 }), (error) => {
    assert.equal(error.category, 'page-guard');
    assert.equal(error.stage, 'document');
    assert.equal(
      error.message,
      `The app frame "Field" was not ready within 0.3 s: its document didn't finish loading.`,
    );
    return true;
  });
  assert.deepEqual(annotations, [{ type: 'app-readiness', description: 'document' }]);
  // Once those frames outlast the guard's own limit, the end-of-test check doesn't repeat them.
  await p.advance(61_000);
  assert.doesNotThrow(() => guard.check());
  assert.deepEqual(
    guard.readiness.map((r) => r.stage),
    ['document'],
  );
});

test('appReady names the attached stage when no app frame shows', async () => {
  const { page } = await harness();
  const p = page();
  p.frame(otherApp);
  p.frame(appId, { displayed: false });
  await p.advance(200);
  await assert.rejects(appReady(p, { timeout: 300 }), {
    stage: 'attached',
    message: 'The app was not ready within 0.3 s: no displayed app frame was attached to the page.',
  });
});

test('appReady waits for nothing under forge tunnel or without app IDs, and needs a guard', async () => {
  const tunnel = process.env.FORGE_TUNNEL;
  process.env.FORGE_TUNNEL = '1';
  try {
    const { page } = await harness();
    assert.deepEqual(await appReady(page(), { timeout: 100 }), []);
  } finally {
    if (tunnel === undefined) delete process.env.FORGE_TUNNEL;
    else process.env.FORGE_TUNNEL = tunnel;
  }
  const { page } = await harness({ appIds: [] });
  assert.deepEqual(await appReady(page(), { timeout: 100 }), []);
  const bare = { context: () => ({}) };
  await assert.rejects(appReady(bare), /needs the page guard/);
  assert.deepEqual(await appReady(bare, { required: false }), []);
});

test('a test records each readiness failure for its suite step, failing or not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  const file = join(dir, 'step.jsonl');
  const saved = process.env.FORGE_TEST_STEP_RESULT;
  process.env.FORGE_TEST_STEP_RESULT = file;
  try {
    const { guard, page } = await harness({ appLoadLimit: 1000 });
    const p = page();
    p.frame(appId);
    const context = { pages: () => [] };
    const info = { title: 'AP-05 configuration', outputPath: (name) => join(dir, name) };
    await assert.rejects(
      guardTest(guard, context, async () => p.advance(1400), info),
      (error) => error.stage === 'placeholder',
    );
    assert.deepEqual(
      readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      [{ kind: 'app-readiness', test: 'AP-05 configuration', stage: 'placeholder' }],
    );
  } finally {
    if (saved === undefined) delete process.env.FORGE_TEST_STEP_RESULT;
    else process.env.FORGE_TEST_STEP_RESULT = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
