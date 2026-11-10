import { randomUUID } from 'node:crypto';
import { config } from '../core/config.mjs';
import { isMarker, markers } from '../core/markers.mjs';

// One hosted suite per site at a time by default, across machines and repositories. Repositories
// share an owned site but not CI concurrency groups or lock files, and a suite can change
// account-wide state (the owner's theme) and site-wide configuration. The lease is a space
// property on the marked identity space (or the landing work item's development space): written,
// then read back after two pauses, so of two simultaneous writers only the one whose value stayed
// proceeds. Jira space properties have no compare-and-swap, so this is a settle window, not an
// atomic lock: a competing write delayed past both pauses is caught by the next renewal instead.
// It is renewed while the suite runs and expires on its own if the holder disappears.
//
// A run that declares what it uses (`uses`, from forge-test.mjs `leaseUses`: names such as
// `app:filter-history` or `confluence:PLSLABEL`) shares the site instead: it holds an entry of its
// own (one property per holder) and runs beside other sharing runs unless they name something in
// common. A whole-site run (no `uses`) still waits for every sharing run, and they wait for it.
// Between a sharing run and any run it conflicts with, the one that wrote first keeps the site:
// both compare start times (then IDs) after their settle pauses, and the later one steps back.
//
// A priority holder (a release or landing run) that has to wait keeps a short-lived reservation
// in a second property. Other conflicting waiters leave a free site to it, and a conflicting
// holder can see it and pause between steps, so a release waits for one step rather than a whole
// suite.
//
// Other waiters take turns in the order they arrived: each keeps a short-lived entry of its own
// (one property per waiter, so no two writers share a value) with the time it first asked, and a
// free site goes to the earliest live conflicting entry. Without it, whichever waiter polled first
// after a release took the site, and one repository could wait out its deadline behind later runs.

const minute = 60_000;

/** A held duration in words: "less than a minute", "1 minute", "12 minutes", "2 h 5 min". */
export function heldFor(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown time';
  const minutes = Math.floor(ms / minute);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** "<holder>, which has held it for <duration>", from a lease value. */
const holding = (value, now) =>
  `${value.holder}, which has held it for ${Number.isFinite(value.since) ? heldFor(now - value.since) : 'an unknown time'}`;

const usePattern = /^[a-z][a-z0-9-]*:[A-Za-z0-9._-]{1,60}$/;

/** A run's declared uses, checked: null for the whole site, else a sorted list of names. */
export function leaseUses(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.length || !value.every((use) => usePattern.test(use)))
    throw Error(
      'leaseUses is a non-empty list of "<kind>:<name>" entries, such as "app:my-app" or "confluence:SPACE".',
    );
  return [...new Set(value)].sort();
}

/** Whether two runs can't share the site: either takes the whole site, or they share a use. */
const conflicts = (a, b) => !a || !b || a.some((use) => b.includes(use));

/** The marked space that holds the lease. */
function leaseProject() {
  const { identity, landing } = config().fixtures;
  if (identity) return { key: identity, marker: markers.identityProject };
  if (landing) return { key: landing.split('-')[0], marker: markers.developmentProject };
  throw Error('Configure fixtures.identity or fixtures.landing to hold the site lease.');
}

/**
 * api: an owned-site client (jira/client.mjs). holder: a public label for logs (never a host or
 * account). priority: whether this holder goes ahead of the others. uses: what this run uses (see
 * above), or nothing for the whole site. Returns { acquire, renew, release, status, heldByOther,
 * priorityWaiting }.
 */
export function siteLease(
  api,
  {
    holder,
    priority = false,
    uses: declared,
    ttl = 15 * minute,
    wait = 120 * minute,
    poll = 30_000,
    settle = 3000,
    now = Date.now,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
    log = console.log,
  } = {},
) {
  const uses = leaseUses(declared);
  const project = leaseProject();
  const properties = `/project/${project.key}/properties`;
  const path = `${properties}/${markers.namespace}.site-lease`;
  const id = randomUUID();
  const read = async () => (await api(path))?.value ?? null;
  // `since` is when this holder first wrote the lease; renewals keep it, so a waiter can say how
  // long the site has been held, and conflicting writers can tell which came first.
  let since;
  const live = (value) => (value && value.expires > now() ? value : null);
  // Sharing holders' entries: `<lease>-use-<id>`, each { id, holder, uses, since, expires }.
  const usePrefix = `${markers.namespace}.site-lease-use-`;
  const mine = `${properties}/${usePrefix}${id}`;
  const write = () =>
    uses
      ? api(mine, 'PUT', { id, holder, uses, since, expires: now() + ttl })
      : api(path, 'PUT', { id, holder, since, expires: now() + ttl });
  // The reservation outlives a few missed polls, so a waiter that gives up frees the site soon.
  const next = `${path}-next`;
  const reserve = () => api(next, 'PUT', { id, holder, uses, expires: now() + 3 * poll });
  const reserved = async () => {
    const value = (await api(next))?.value;
    return value && value.id !== id && value.expires > now() && conflicts(value.uses, uses)
      ? value
      : null;
  };
  // Waiters' entries: `<lease>-wait-<id>`, each { id, holder, uses, joined, expires }.
  const queuePrefix = `${markers.namespace}.site-lease-wait-`;
  const entry = `${properties}/${queuePrefix}${id}`;
  // When this lease first asked for the site; kept across acquires, so a suite resuming after a
  // pause keeps its place ahead of runs that arrived after it.
  let joined;
  let queued = false;
  const enqueue = async () => {
    await api(entry, 'PUT', { id, holder, uses, joined, expires: now() + 3 * poll });
    queued = true;
  };
  const dequeue = async () => {
    if (!queued) return;
    queued = false;
    await api(entry, 'DELETE');
  };
  /**
   * The live values of other entries under a prefix; lapsed ones (a killed run's) are deleted.
   */
  const entries = async (prefix, valid) => {
    const keys = (await api(properties))?.keys ?? [];
    const found = [];
    for (const { key } of keys) {
      if (!key.startsWith(prefix) || key.endsWith(id)) continue;
      const at = `${properties}/${key}`;
      const value = (await api(at))?.value;
      if (value && value.expires > now() && valid(value)) found.push(value);
      else if (value) await api(at, 'DELETE').catch(() => {});
    }
    return found;
  };
  /** Other live sharing holders. */
  const sharing = () => entries(usePrefix, (value) => Array.isArray(value.uses));
  /**
   * The earliest live conflicting waiter that arrived before this one, or null. Entries of
   * waiters that stopped renewing (a killed run) lapse within a few polls and are deleted.
   */
  const earlier = async () => {
    const waiters = await entries(queuePrefix, (value) => Number.isFinite(value.joined));
    const before = (w) => w.joined < joined || (w.joined === joined && w.id < id);
    return (
      waiters
        .filter((w) => before(w) && conflicts(w.uses, uses))
        .sort((a, b) => a.joined - b.joined)[0] ?? null
    );
  };
  /** Whether holder `a` wrote before this one. */
  const first = (a) => a.since < since || (a.since === since && a.id < id);
  /** Every live holder conflicting with this run, other than this one. */
  const blocking = async () => {
    const whole = live(await read());
    const others = (await sharing()).filter((value) => conflicts(value.uses, uses));
    return [...(whole && whole.id !== id ? [whole] : []), ...others];
  };
  /**
   * After writing and settling: whether this holder keeps the site. A whole-site holder keeps it
   * when its value stayed and no sharing holder started first, and waits a few pauses for later
   * ones to step back. A sharing holder keeps it when no conflicting holder started first.
   */
  const kept = async () => {
    if (!uses) {
      for (let check = 0; check < 2; check++) {
        await sleep(settle);
        if ((await read())?.id !== id) return false;
      }
      for (let check = 0; ; check++) {
        const others = await sharing();
        if (!others.length) return true;
        if (others.some(first) || check === 3) return false;
        await sleep(settle);
      }
    }
    for (let check = 0; check < 2; check++) await sleep(settle);
    if ((await api(mine))?.value?.id !== id) return false;
    return !(await blocking()).some((value) => !Number.isFinite(value.since) || first(value));
  };
  /** Removes this holder's own value, if it is still there. */
  const withdraw = async () => {
    if (uses) await api(mine, 'DELETE');
    else if ((await read())?.id === id) await api(path, 'DELETE');
  };
  let held = false;
  return {
    /** This lease's identifier, which a suite passes to its steps as FORGE_TEST_LEASE. */
    id,
    /**
     * Read-only: the label of a live holder conflicting with this run, or null when there is
     * none or `own` (a suite's lease ID) is the only one.
     */
    async heldByOther(own) {
      const other = (await blocking()).find((value) => value.id !== own);
      return other?.holder ?? null;
    },
    /**
     * Read-only: null when no run holds the site, else the first holder conflicting with this
     * run (or this run's own, or the suite lease `own`'s): `holder` is its public label, `since`
     * and `expires` are epoch milliseconds (`since` is null for a lease written by an earlier
     * version), `heldMs` is how long it has been held, `own` whether it is this lease or `own`,
     * `priorityWaiting` the label of a priority run waiting for the site, or null, and `holders`
     * every live holder ({ holder, uses, since, expires }; `uses` null for the whole site).
     */
    async status(own = id) {
      const whole = live(await read());
      const all = [...(whole ? [{ ...whole, uses: null }] : []), ...(await sharing())];
      // Other holders' entries leave this lease's own out; a sharing holder adds it back.
      const self = uses ? live((await api(mine))?.value) : null;
      if (self) all.push(self);
      const isOwn = (value) => value.id === id || value.id === own;
      const current =
        all.find((value) => !isOwn(value) && conflicts(value.uses, uses)) ??
        all.find(isOwn) ??
        null;
      if (!current) return null;
      const known = Number.isFinite(current.since);
      return {
        holder: current.holder,
        since: known ? current.since : null,
        heldMs: known ? now() - current.since : null,
        expires: current.expires,
        own: isOwn(current),
        priorityWaiting: live((await api(next))?.value)?.holder ?? null,
        holders: all.map((value) => ({
          holder: value.holder,
          uses: value.uses ?? null,
          since: Number.isFinite(value.since) ? value.since : null,
          expires: value.expires,
        })),
      };
    },
    /** Waits up to `wait` milliseconds (the lease's own by default) for the site, then holds it. */
    async acquire({ wait: patience = wait } = {}) {
      const owned = await api(`/project/${project.key}`);
      if (!isMarker(owned?.description, project.marker))
        throw Error('The site lease space is not a marked fixture space.');
      const deadline = now() + patience;
      joined ??= now();
      let waiting;
      for (;;) {
        const holders = await blocking();
        const free = !holders.length;
        const reservation = free && !priority ? await reserved() : null;
        const queue = free && !priority && !reservation ? await earlier() : null;
        const ahead = reservation ?? queue;
        if (free && !ahead) {
          since = now();
          await write();
          if (await kept()) {
            held = true;
            if (priority && (await api(next))?.value?.id === id) await api(next, 'DELETE');
            await dequeue();
            return;
          }
          await withdraw();
          continue;
        }
        const other = ahead ?? holders[0];
        if (now() >= deadline) {
          await dequeue().catch(() => {});
          throw Object.assign(
            Error(
              reservation
                ? `The site is reserved for ${other.holder}, which goes first; try again later.`
                : queue
                  ? `${other.holder} is waiting for the site and goes first; try again later.`
                  : `The site is still in use by ${holding(other, now())}; try again later.`,
            ),
            { siteBusy: true, holder: other.holder },
          );
        }
        if (waiting !== other.id)
          log(
            reservation
              ? `Waiting for ${other.holder}, which goes first on this site.`
              : queue
                ? `Waiting for ${other.holder}, which asked for this site first.`
                : `Waiting for ${holding(other, now())}, to finish on this site (up to ${heldFor(deadline - now())}).`,
          );
        waiting = other.id;
        if (priority) await reserve();
        else await enqueue();
        await sleep(poll);
      }
    },
    /**
     * Read-only: the label of a conflicting priority run waiting for this site while this lease
     * holds it, or null. A priority holder never gives way.
     */
    async priorityWaiting() {
      if (priority || !held) return null;
      return (await reserved())?.holder ?? null;
    },
    /**
     * Extends the lease; throws an error marked leaseLost when another holder took it over (or,
     * for a sharing holder, its entry is gone). After release it does nothing, so a renewal in
     * flight cannot recreate the lease.
     */
    async renew() {
      if (!held) return;
      const current = uses ? (await api(mine))?.value : await read();
      if (current?.id !== id)
        throw Object.assign(Error('The site lease was lost.'), { leaseLost: true });
      if (held) await write();
    },
    async release() {
      await dequeue().catch(() => {});
      if (!held) return;
      held = false;
      await withdraw();
    },
  };
}
