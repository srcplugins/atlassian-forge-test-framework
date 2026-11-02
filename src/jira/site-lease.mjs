import { randomUUID } from 'node:crypto';
import { config } from '../core/config.mjs';
import { isMarker, markers } from '../core/markers.mjs';

// One hosted suite per site at a time, across machines and repositories. Repositories share an
// owned site but not CI concurrency groups or lock files, and a suite changes account-wide
// state (the owner's theme) and site-wide configuration. The lease is a space property on the
// marked identity space (or the landing work item's development space): written, then read back
// after two pauses, so of two simultaneous writers only the one whose value stayed proceeds.
// Jira space properties have no compare-and-swap, so this is a settle window, not an atomic
// lock: a competing write delayed past both pauses is caught by the next renewal instead. It is
// renewed while the suite runs and expires on its own if the holder disappears.
//
// A priority holder (a release or landing run) that has to wait keeps a short-lived reservation
// in a second property. Other waiters leave a free site to it, and another holder can see it and
// pause between steps, so a release waits for one step rather than a whole suite.

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

/** The marked space that holds the lease. */
function leaseProject() {
  const { identity, landing } = config().fixtures;
  if (identity) return { key: identity, marker: markers.identityProject };
  if (landing) return { key: landing.split('-')[0], marker: markers.developmentProject };
  throw Error('Configure fixtures.identity or fixtures.landing to hold the site lease.');
}

/**
 * api: an owned-site client (jira/client.mjs). holder: a public label for logs (never a host or
 * account). priority: whether this holder goes ahead of the others. Returns { acquire, renew,
 * release, priorityWaiting }.
 */
export function siteLease(
  api,
  {
    holder,
    priority = false,
    ttl = 15 * minute,
    wait = 60 * minute,
    poll = 30_000,
    settle = 3000,
    now = Date.now,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
    log = console.log,
  } = {},
) {
  const project = leaseProject();
  const path = `/project/${project.key}/properties/${markers.namespace}.site-lease`;
  const id = randomUUID();
  const read = async () => (await api(path))?.value ?? null;
  // `since` is when this holder first wrote the lease; renewals keep it, so a waiter can say how
  // long the site has been held.
  let since;
  const write = () => api(path, 'PUT', { id, holder, since, expires: now() + ttl });
  const live = (value) => (value && value.expires > now() ? value : null);
  // The reservation outlives a few missed polls, so a waiter that gives up frees the site soon.
  const next = `${path}-next`;
  const reserve = () => api(next, 'PUT', { id, holder, expires: now() + 3 * poll });
  const reserved = async () => {
    const value = (await api(next))?.value;
    return value && value.id !== id && value.expires > now() ? value : null;
  };
  let held = false;
  return {
    /** This lease's identifier, which a suite passes to its steps as FORGE_TEST_LEASE. */
    id,
    /**
     * Read-only: the label of a live lease held by someone else, or null when the site is free,
     * the lease expired, or `own` (a suite's lease ID) holds it.
     */
    async heldByOther(own) {
      const current = live(await read());
      return current && current.id !== own ? current.holder : null;
    },
    /**
     * Read-only: the live lease, or null when the site is free or the lease expired. `holder` is
     * its public label, `since` and `expires` are epoch milliseconds (`since` is null for a lease
     * written by an earlier version), `heldMs` is how long it has been held, `own` whether this
     * lease or the suite lease `own` holds it, and `priorityWaiting` the label of a priority run
     * waiting for the site, or null.
     */
    async status(own = id) {
      const current = live(await read());
      if (!current) return null;
      const known = Number.isFinite(current.since);
      return {
        holder: current.holder,
        since: known ? current.since : null,
        heldMs: known ? now() - current.since : null,
        expires: current.expires,
        own: current.id === id || current.id === own,
        priorityWaiting: live((await api(next))?.value)?.holder ?? null,
      };
    },
    /** Waits up to `wait` milliseconds (the lease's own by default) for the site, then holds it. */
    async acquire({ wait: patience = wait } = {}) {
      const owned = await api(`/project/${project.key}`);
      if (!isMarker(owned?.description, project.marker))
        throw Error('The site lease space is not a marked fixture space.');
      const deadline = now() + patience;
      let waiting;
      for (;;) {
        const current = await read();
        const free = !current || current.id === id || !(current.expires > now());
        const ahead = free && !priority ? await reserved() : null;
        if (free && !ahead) {
          since = now();
          await write();
          // A competitor's write that lands after the first read-back still shows in the second.
          let kept = true;
          for (let check = 0; check < 2 && kept; check++) {
            await sleep(settle);
            kept = (await read())?.id === id;
          }
          if (kept) {
            held = true;
            if (priority && (await api(next))?.value?.id === id) await api(next, 'DELETE');
            return;
          }
          continue;
        }
        const other = ahead ?? current;
        if (now() >= deadline)
          throw Object.assign(
            Error(
              ahead
                ? `The site is reserved for ${other.holder}, which goes first; try again later.`
                : `The site is still in use by ${holding(other, now())}; try again later.`,
            ),
            { siteBusy: true, holder: other.holder },
          );
        if (waiting !== other.id)
          log(
            ahead
              ? `Waiting for ${other.holder}, which goes first on this site.`
              : `Waiting for ${holding(other, now())}, to finish on this site (up to ${heldFor(deadline - now())}).`,
          );
        waiting = other.id;
        if (priority) await reserve();
        await sleep(poll);
      }
    },
    /**
     * Read-only: the label of a priority run waiting for this site while this lease holds it, or
     * null. A priority holder never gives way.
     */
    async priorityWaiting() {
      if (priority || !held) return null;
      return (await reserved())?.holder ?? null;
    },
    /**
     * Extends the lease; throws an error marked leaseLost when another holder took it over.
     * After release it does nothing, so a renewal in flight cannot recreate the lease.
     */
    async renew() {
      if (!held) return;
      if ((await read())?.id !== id)
        throw Object.assign(Error('The site lease was lost.'), { leaseLost: true });
      if (held) await write();
    },
    async release() {
      if (!held) return;
      held = false;
      if ((await read())?.id === id) await api(path, 'DELETE');
    },
  };
}
