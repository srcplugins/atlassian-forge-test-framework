import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageGuard } from '../src/jira/guard.mjs';

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
  context.addInitScript = async (script, arg) => {
    context.script = { source: String(script), arg };
  };
  const guard = await pageGuard(context, {
    appIds: [appId],
    annotate: (type, description) => annotations.push({ type, description }),
    ...options,
  });
  const page = ({ top = true } = {}) => {
    const p = { alerts: [], frames: [], now: 0 };
    const window = {};
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
      'arg',
      `(${context.script.source})(arg)`,
    )(
      window,
      document,
      (el) => ({ visibility: el.visibility }),
      setInterval,
      { now: () => p.now },
      context.script.arg,
    );
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
    // a frame that stays hidden.
    p.frame = (id, { title = 'Agent Prompts', displayed = true } = {}) => {
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
      error.message ===
        `The app frame "Agent Prompts" stayed behind Jira's loading placeholder for more than 15 s.`,
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
  for (const change of [
    (frame) => (frame.skeleton = false),
    (frame) => (frame.visibility = 'visible'),
  ]) {
    const { guard, page } = await harness({ appLoadLimit: 15_000 });
    const p = page();
    change(p.frame(appId));
    await p.advance(15_400);
    assert.throws(() => guard.check(), /stayed behind Jira's loading placeholder/);
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
  assert.deepEqual(annotations, []);
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
  const { guard } = await harness();
  assert.throws(() => guard.allowFlag({}), /string or a regular expression/);
});
