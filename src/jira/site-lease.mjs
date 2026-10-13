import { randomUUID } from 'node:crypto';
import { config } from '../core/config.mjs';
import { isMarker, markers } from '../core/markers.mjs';

// One hosted suite per site at a time, across machines and repositories. Repositories share an
// owned site but not CI concurrency groups or lock files, and a suite changes account-wide
// state (the owner's theme) and site-wide configuration. The lease is a project property on the
// marked identity project (or the landing issue's development project): written, then read back
// after two pauses, so of two simultaneous writers only the one whose value stayed proceeds.
// Jira project properties have no compare-and-swap, so this is a settle window, not an atomic
// lock: a competing write delayed past both pauses is caught by the next renewal instead. It is
// renewed while the suite runs and expires on its own if the holder disappears.

const minute = 60_000;

/** The marked project that holds the lease. */
function leaseProject() {
  const { identity, landing } = config().fixtures;
  if (identity) return { key: identity, marker: markers.identityProject };
  if (landing) return { key: landing.split('-')[0], marker: markers.developmentProject };
  throw Error('Configure fixtures.identity or fixtures.landing to hold the site lease.');
}

/**
 * api: an owned-site client (jira/client.mjs). holder: a public label for logs (never a host or
 * account). Returns { acquire, renew, release }.
 */
export function siteLease(
  api,
  {
    holder,
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
  const write = () => api(path, 'PUT', { id, holder, expires: now() + ttl });
  let held = false;
  return {
    async acquire() {
      const owned = await api(`/project/${project.key}`);
      if (!isMarker(owned?.description, project.marker))
        throw Error('The site lease project is not a marked fixture project.');
      const deadline = now() + wait;
      let waiting;
      for (;;) {
        const current = await read();
        if (!current || current.id === id || !(current.expires > now())) {
          await write();
          // A competitor's write that lands after the first read-back still shows in the second.
          let kept = true;
          for (let check = 0; check < 2 && kept; check++) {
            await sleep(settle);
            kept = (await read())?.id === id;
          }
          if (kept) {
            held = true;
            return;
          }
          continue;
        }
        if (now() >= deadline)
          throw Error(`The site is still in use by ${current.holder}; try again later.`);
        if (waiting !== current.id) log(`Waiting for ${current.holder} to finish on this site.`);
        waiting = current.id;
        await sleep(poll);
      }
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
