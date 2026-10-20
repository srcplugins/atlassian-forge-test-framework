// A page-level oracle that every feature test gets: it fails a test when Jira shows an error flag
// that the test didn't declare, or when an app frame stays behind Jira's loading placeholder.
// Jira's flags are Atlaskit flags (role="alert" with a heading). While an app loads, Jira shows
// Forge's skeletons (data-testid "forgeskeleton-N") beside the app's iframe and keeps the iframe at
// visibility: hidden. A UI Kit app then renders into Jira's page next to an iframe that stays
// hidden; a Custom UI app's iframe becomes visible.

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

// Runs in every page of the test's context, in the top document only. Reports each flag once per
// text, and each app frame once when it loads or when it outlasts the limit.
function watch({ appIds, limit, binding }) {
  if (window !== window.top) return;
  const report = (event) => window[binding]?.(event)?.catch?.(() => {});
  const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const flags = new WeakMap();
  const frames = new Map();
  setInterval(() => {
    for (const alert of document.querySelectorAll('[role="alert"]')) {
      const heading = alert.querySelector('h1,h2,h3,h4,h5,h6');
      const title = heading && text(heading);
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
      if (!state) frames.set(frame, (state = { since: now }));
      if (state.done) continue;
      const name = frame.title || 'untitled';
      const container = frame.closest('[data-testid="hosted-resources-iframe-container"]');
      const wrapper =
        frame.closest('#forge-ui-height-observer-wrapper') ??
        container?.parentElement ??
        frame.parentElement;
      const skeleton = '[data-testid^="forgeskeleton"]';
      const rendered = [...wrapper.children].some(
        (child) =>
          !child.contains(frame) &&
          !child.matches(skeleton) &&
          child.getBoundingClientRect().height > 0,
      );
      const hidden = getComputedStyle(frame).visibility === 'hidden';
      // A frame inside a collapsed or undisplayed section has no boxes and isn't waiting.
      if (!frame.getClientRects().length) state.since = now;
      else if (!wrapper.querySelector(skeleton) && (!hidden || rendered)) {
        state.done = true;
        report({ kind: 'frame-loaded', title: name, ms: Math.round(now - state.since) });
      } else if (now - state.since > limit) {
        state.done = true;
        report({ kind: 'frame-stuck', title: name, ms: Math.round(now - state.since) });
      }
    }
  }, 200);
}

const matches = (pattern, flag) =>
  typeof pattern === 'string' ? flag.text.includes(pattern) : pattern.test(flag.text);

/**
 * Watches every page of a browser context. `expectedFlags` are strings (contained in the flag's
 * text) or regular expressions for error flags the test expects; `appLoadLimit` is in ms.
 */
export async function pageGuard(
  context,
  { appIds = [], appLoadLimit = 15_000, expectedFlags = [], annotate = () => {} } = {},
) {
  for (const pattern of expectedFlags)
    if (typeof pattern !== 'string' && !(pattern instanceof RegExp))
      throw Error('An expected flag is a string or a regular expression.');
  if (!Number.isFinite(appLoadLimit) || appLoadLimit <= 0)
    throw Error('appLoadLimit is a positive number of milliseconds.');
  const flags = [];
  const stuck = [];
  const allowed = [...expectedFlags];
  const reported = new Set();
  await context.exposeBinding(binding, (_source, event) => {
    if (event?.kind === 'flag') {
      const flag = {
        title: String(event.title),
        text: String(event.text),
        at: Date.now(),
      };
      flag.error = errorFlags.some((pattern) => pattern.test(flag.text));
      flags.push(flag);
      annotate('jira-flag', flag.text);
    } else if (event?.kind === 'frame-loaded') annotate('app-frame-ms', String(event.ms));
    else if (event?.kind === 'frame-stuck') stuck.push(event);
  });
  await context.addInitScript(watch, { appIds, limit: appLoadLimit, binding });
  const problems = () => [
    ...flags
      .filter((flag) => flag.error && !allowed.some((pattern) => matches(pattern, flag)))
      .map((flag) => `Jira showed the error flag "${flag.text}".`),
    ...stuck.map(
      (frame) =>
        `The app frame "${frame.title}" stayed behind Jira's loading placeholder for more than ${appLoadLimit / 1000} s.`,
    ),
  ];
  const guard = {
    /** Every flag seen so far: { title, text, at, error }. */
    get flags() {
      return flags.map((flag) => ({ ...flag }));
    },
    /** Declares an error flag the test expects, like the expectedFlags option. */
    allowFlag(pattern) {
      if (typeof pattern !== 'string' && !(pattern instanceof RegExp))
        throw Error('An expected flag is a string or a regular expression.');
      allowed.push(pattern);
    },
    /**
     * Throws now if Jira has shown an undeclared error flag or an app frame never loaded. Each
     * problem is reported once, so the end-of-test check doesn't repeat one already thrown.
     */
    check() {
      const found = problems().filter((problem) => !reported.has(problem));
      if (!found.length) return;
      for (const problem of found) reported.add(problem);
      const error = Error(found.join('\n'));
      error.category = 'page-guard';
      throw error;
    },
    /** The first flag after `since` (ms) whose title matches, or a failure after `timeout`. */
    async waitForFlag(pattern, { since = 0, timeout = 20_000 } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const flag = flags.find((f) => f.at >= since && pattern.test(f.title));
        if (flag) return { ...flag };
        if (Date.now() >= deadline) throw Error(`Jira showed no flag matching ${pattern}.`);
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
        throw Error(`Jira showed no Create outcome flag within ${timeout / 1000} s.`);
      }
      guard.check();
    },
  };
  return guard;
}
