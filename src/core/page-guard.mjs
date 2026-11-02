import { recordStepResult } from './suite.mjs';

// Shared Forge page watcher, with Jira defaults preserved. Confluence opts into headingless flags.
// A page-level oracle that every feature test gets: it fails a test when Jira shows an error flag
// that the test didn't declare, or when an app frame isn't ready within the limit.
// Jira's flags are Atlaskit flags (role="alert" with a heading). While an app loads, Jira shows
// Forge's skeletons (data-testid "forgeskeleton-N") beside the app's iframe and keeps the iframe at
// visibility: hidden. A UI Kit app then renders into Jira's page next to an iframe that stays
// hidden; a Custom UI app's iframe becomes visible.
//
// An app frame is ready once it passed every readiness stage, in order:
//   attached     an app iframe (its src holds the app ID) is in the page and displayed;
//   document     the iframe's document finished loading (its load event);
//   placeholder  Forge's loading placeholder is gone from beside it;
//   root         the app rendered its root: a Custom UI frame became visible, or a UI Kit app's
//                content shows beside its hidden frame.
// A frame whose placeholder is gone and whose root shows is ready even if its load event was
// missed, so the document stage only names why a frame that isn't ready is waiting.

/** Flag text that marks a Jira flag as an error. */
const errorFlags = [
  /\bwith exceptions\b/i,
  /\bsomething went wrong\b/i,
  /\b(?:couldn[’']t|could not|unable to|failed to)\b/i,
  /\berror\b/i,
];
// The flag Jira shows once a Create form's work item and its fields are saved, or with exceptions.
const createOutcome = /^(?:you[’']ve created|created)\b/i;
const binding = '__forgeTestPageGuard';
const frameState = '__forgeTestAppFrames';

/**
 * How long an app frame may take to be ready, in ms. Loaded frames are ready within a few
 * seconds; the bound is the default `expect` timeout of the framework's Playwright configuration,
 * so the guard never fails a test before its own default assertion would, and stays well inside
 * the lane's test timeout, so a frame that never loads fails with its stage named rather than
 * with a test timeout.
 */
export const defaultAppLoadLimit = 30_000;

/** The readiness stages, in order. */
export const readinessStages = ['attached', 'document', 'placeholder', 'root'];

const stageText = (stage, product) =>
  ({
    attached: 'no displayed app frame was attached to the page',
    document: "its document didn't finish loading",
    placeholder: `it stayed behind ${product}'s loading placeholder`,
    root: 'the app never rendered its root (the frame stayed hidden with nothing rendered beside it)',
  })[stage];

/**
 * The first readiness stage an attached app frame hasn't passed, 'ready' when it passed them
 * all, or 'undisplayed' for a frame in a collapsed or hidden section, which isn't waiting. It
 * runs in the page too, so it uses nothing outside itself.
 */
export function frameStage({ displayed, loaded, placeholder, visible, rendered }) {
  if (!displayed) return 'undisplayed';
  if (!placeholder && (visible || rendered)) return 'ready';
  if (!loaded) return 'document';
  if (placeholder) return 'placeholder';
  return 'root';
}

// Runs in every page of the test's context, in the top document only. Reports each flag once per
// text, and each app frame once when it is ready and once when it outlasts the limit; keeps each
// app frame's current stage for `appReady`.
function watch({ appIds, limit, binding, frameState, requireFlagHeading }, frameStage) {
  if (window !== window.top) return;
  const report = (event) => window[binding]?.(event)?.catch?.(() => {});
  const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const flags = new WeakMap();
  const frames = new Map();
  // An iframe's load event doesn't bubble, but a capturing listener on the window sees it. The
  // src it loaded is kept, so a frame sent elsewhere is loading again until its next load.
  const loads = new WeakMap();
  window.addEventListener(
    'load',
    (event) => {
      if (event.target?.tagName === 'IFRAME') loads.set(event.target, event.target.src);
    },
    true,
  );
  const page = Math.random().toString(36).slice(2);
  let count = 0;
  window[frameState] = () =>
    [...frames.values()].map(({ key, title, stage, ms }) => ({ key, title, stage, ms }));
  setInterval(() => {
    for (const alert of document.querySelectorAll('[role="alert"]')) {
      const heading = alert.querySelector('h1,h2,h3,h4,h5,h6');
      const title = heading ? text(heading) : requireFlagHeading ? null : text(alert).slice(0, 120);
      const all = text(alert);
      if (!title || flags.get(alert) === all) continue;
      flags.set(alert, all);
      report({ kind: 'flag', title, text: all });
    }
    const now = performance.now();
    for (const [frame] of frames) if (!frame.isConnected) frames.delete(frame);
    for (const frame of document.querySelectorAll('iframe[src]')) {
      if (!appIds.some((id) => frame.src.includes(id))) continue;
      let state = frames.get(frame);
      if (!state) frames.set(frame, (state = { key: `${page}:${++count}`, since: now }));
      state.title = frame.title || 'untitled';
      if (state.stage === 'ready') continue;
      const container = frame.closest('[data-testid="hosted-resources-iframe-container"]');
      const wrapper =
        frame.closest('#forge-ui-height-observer-wrapper') ??
        container?.parentElement ??
        frame.parentElement;
      const skeleton = '[data-testid^="forgeskeleton"]';
      state.stage = frameStage({
        displayed: frame.getClientRects().length > 0,
        loaded: loads.get(frame) === frame.src,
        placeholder: !!wrapper.querySelector(skeleton),
        visible: getComputedStyle(frame).visibility !== 'hidden',
        rendered: [...wrapper.children].some(
          (child) =>
            !child.contains(frame) &&
            !child.matches(skeleton) &&
            child.getBoundingClientRect().height > 0,
        ),
      });
      // A frame inside a collapsed or undisplayed section has no boxes and isn't waiting.
      if (state.stage === 'undisplayed') state.since = now;
      state.ms = Math.round(now - state.since);
      if (state.stage === 'ready')
        report({ kind: 'frame-loaded', key: state.key, title: state.title, ms: state.ms });
      else if (!state.stuck && now - state.since > limit) {
        // Still watched, so a frame that is ready later records its load time too.
        state.stuck = true;
        report({
          kind: 'frame-stuck',
          key: state.key,
          title: state.title,
          ms: state.ms,
          stage: state.stage,
        });
      }
    }
  }, 200);
}

const matches = (pattern, flag) =>
  typeof pattern === 'string' ? flag.text.includes(pattern) : pattern.test(flag.text);

// Each context's guard, so `appReady(page)` finds the guard watching that page.
const guards = new WeakMap();

/**
 * Watches every page of a browser context. `expectedFlags` are strings (contained in the flag's
 * text) or regular expressions for error flags the test expects; `appLoadLimit` is in ms.
 */
export async function pageGuard(
  context,
  {
    appIds = [],
    appLoadLimit = defaultAppLoadLimit,
    expectedFlags = [],
    annotate = () => {},
    product = 'Jira',
    requireFlagHeading = true,
  } = {},
) {
  for (const pattern of expectedFlags)
    if (typeof pattern !== 'string' && !(pattern instanceof RegExp))
      throw Error('An expected flag is a string or a regular expression.');
  if (!Number.isFinite(appLoadLimit) || appLoadLimit <= 0)
    throw Error('appLoadLimit is a positive number of milliseconds.');
  const flags = [];
  const stuck = [];
  // App readiness failures, from the watcher or from `appReady`: { title, stage, ms }.
  const readiness = [];
  // Frames whose failure `appReady` already threw, so the end-of-test check doesn't repeat it.
  const raised = new Set();
  const allowed = [...expectedFlags];
  const reported = new Set();
  const seconds = (ms) => `${Math.round(ms / 100) / 10} s`;
  await context.exposeBinding(binding, (_source, event) => {
    if (event?.kind === 'flag') {
      const flag = {
        title: String(event.title),
        text: String(event.text),
        at: Date.now(),
      };
      flag.error = errorFlags.some((pattern) => pattern.test(flag.text));
      flags.push(flag);
      annotate(`${product.toLowerCase()}-flag`, flag.text);
    } else if (event?.kind === 'frame-loaded') annotate('app-frame-ms', String(event.ms));
    else if (event?.kind === 'frame-stuck' && readinessStages.includes(event.stage)) {
      const failure = { title: String(event.title), stage: event.stage, ms: event.ms };
      stuck.push({ ...failure, key: event.key });
      if (!raised.has(event.key)) {
        readiness.push(failure);
        annotate('app-readiness', failure.stage);
      }
    }
  });
  await context.addInitScript(
    `(${watch})(${JSON.stringify({ appIds, limit: appLoadLimit, binding, frameState, requireFlagHeading })}, ${frameStage})`,
  );
  const frameProblem = (frame) =>
    `The app frame "${frame.title}" was not ready after ${seconds(appLoadLimit)}: ${stageText(frame.stage, product)}.`;
  const problems = () => [
    ...flags
      .filter((flag) => flag.error && !allowed.some((pattern) => matches(pattern, flag)))
      .map((flag) => ({ message: `${product} showed the error flag "${flag.text}".` })),
    ...stuck
      .filter((frame) => !raised.has(frame.key))
      .map((frame) => ({ message: frameProblem(frame), stage: frame.stage })),
  ];
  const guard = {
    /** Every flag seen so far: { title, text, at, error }. */
    get flags() {
      return flags.map((flag) => ({ ...flag }));
    },
    /** Every app readiness failure so far: { title, stage, ms }, stage from `readinessStages`. */
    get readiness() {
      return readiness.map((failure) => ({ ...failure }));
    },
    /** Declares an error flag the test expects, like the expectedFlags option. */
    allowFlag(pattern) {
      if (typeof pattern !== 'string' && !(pattern instanceof RegExp))
        throw Error('An expected flag is a string or a regular expression.');
      allowed.push(pattern);
    },
    /**
     * Throws now if Jira has shown an undeclared error flag or an app frame wasn't ready in time.
     * Each problem is reported once, so the end-of-test check doesn't repeat one already thrown.
     * The error's `stage` names the first readiness stage that failed, if any.
     */
    check() {
      const found = problems().filter((problem) => !reported.has(problem.message));
      if (!found.length) return;
      for (const problem of found) reported.add(problem.message);
      const error = Error(found.map((problem) => problem.message).join('\n'));
      error.category = 'page-guard';
      const stage = found.find((problem) => problem.stage)?.stage;
      if (stage) error.stage = stage;
      throw error;
    },
    /**
     * Waits until every displayed app frame on `page` is ready, and at least one is: the one
     * readiness probe. Resolves the frames ({ title, stage, ms }); after `timeout` ms it throws,
     * naming the first stage the slowest frame hadn't passed ('attached' when no app frame
     * showed). Without app IDs, or under `forge tunnel` (FORGE_TUNNEL=1), whose frames come from
     * localhost, there is nothing to wait for.
     */
    async appReady(page, { timeout = appLoadLimit } = {}) {
      if (!appIds.length || process.env.FORGE_TUNNEL === '1') return [];
      const deadline = Date.now() + timeout;
      let frames = [];
      for (;;) {
        frames = (
          (await page.evaluate((name) => window[name]?.() ?? null, frameState).catch(() => null)) ??
          frames
        ).filter((frame) => frame.stage !== 'undisplayed');
        if (frames.length && frames.every((frame) => frame.stage === 'ready')) return frames;
        if (Date.now() >= deadline) break;
        await new Promise((done) => setTimeout(done, 250));
      }
      const waiting = frames.filter((frame) => frame.stage !== 'ready');
      const slowest = waiting.sort(
        (a, b) => readinessStages.indexOf(a.stage) - readinessStages.indexOf(b.stage),
      )[0];
      const stage = slowest?.stage ?? 'attached';
      const title = slowest?.title ?? null;
      for (const frame of waiting) raised.add(frame.key);
      // The watcher may have recorded this frame's failure already.
      if (!slowest || !stuck.some((frame) => frame.key === slowest.key)) {
        readiness.push({ title, stage, ms: slowest?.ms ?? timeout });
        annotate('app-readiness', stage);
      }
      const error = Error(
        `The app${title ? ` frame "${title}"` : ''} was not ready within ${seconds(timeout)}: ${stageText(stage, product)}.`,
      );
      error.category = 'page-guard';
      error.stage = stage;
      throw error;
    },
    /** The first flag after `since` (ms) whose title matches, or a failure after `timeout`. */
    async waitForFlag(pattern, { since = 0, timeout = 20_000 } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const flag = flags.find((f) => f.at >= since && pattern.test(f.title));
        if (flag) return { ...flag };
        if (Date.now() >= deadline) throw Error(`${product} showed no flag matching ${pattern}.`);
        await new Promise((done) => setTimeout(done, 100));
      }
    },
    /**
     * After a Create form's submit: waits for Jira's outcome flag ("You've created …" or
     * "Created … with exceptions"), then fails at once on an undeclared error flag.
     */
    async createOutcome({ since, timeout = 20_000 }) {
      try {
        await guard.waitForFlag(createOutcome, { since, timeout });
      } catch {
        guard.check();
        throw Error(`${product} showed no Create outcome flag within ${timeout / 1000} s.`);
      }
      guard.check();
    },
  };
  guards.set(context, guard);
  return guard;
}

/**
 * Waits until the app on `page` is ready (the page guard's `appReady`), or throws naming the
 * readiness stage that failed. Needs the page guard, which every test from /jira or /confluence
 * has; with `required: false` a page without one (a runner's own browser) resolves at once.
 */
export async function appReady(page, { required = true, ...options } = {}) {
  const guard = guards.get(page.context());
  if (guard) return guard.appReady(page, options);
  if (required) throw Error('appReady needs the page guard: use test from /jira or /confluence.');
  return [];
}

/**
 * The page guard fixture's body: runs the test, fails it on any problem the guard saw (with a
 * page-guard.png screenshot), and records each readiness failure for a suite's receipt.
 */
export async function guardTest(guard, context, use, info) {
  try {
    await use(guard);
    try {
      guard.check();
    } catch (error) {
      const [page] = context.pages();
      await page?.screenshot({ path: info.outputPath('page-guard.png') }).catch(() => {});
      throw error;
    }
  } finally {
    recordStepResult(
      guard.readiness.map(({ stage }) => ({ kind: 'app-readiness', test: info.title, stage })),
    );
  }
}
