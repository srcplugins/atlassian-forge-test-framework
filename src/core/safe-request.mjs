// Browser/API exceptions can contain session headers. Keep raw causes out of reports: the error
// names only the stage and, from the fixed lists below, the kind of failure, so an intermittent
// failure can be told apart without any of its message, headers or body.
const codes = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
];
const phrases = [
  [/socket hang up/i, 'socket hang up'],
  [/Timeout \d+ms exceeded/, 'timeout'],
  [/has been closed|disposed/i, 'closed'],
  [/\bfetch failed\b/, 'fetch failed'],
];
const names = ['AbortError', 'TimeoutError', 'SyntaxError', 'TypeError'];
// Kinds where the connection dropped or stalled, so the same read may well succeed at once.
// A refused or unresolvable host, a closed context or a parse error would fail the same way again.
const transientKinds = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'socket hang up',
  'timeout',
  'TimeoutError',
]);
const lastingKinds = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH']);

/** The kinds of a transport failure, taken only from the fixed lists; never its text. */
function kinds(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const cause = error?.cause;
  const code = [error?.code, cause?.code].find((c) => codes.includes(c));
  const found = [
    names.includes(error?.name) && error.name,
    code ?? codes.find((c) => new RegExp(`\\b${c}\\b`).test(message)),
    phrases.find(([pattern]) => pattern.test(message))?.[1],
  ].filter(Boolean);
  return [...new Set(found)];
}

/** Whether these kinds name a dropped or stalled connection rather than a lasting fault. */
const transient = (found) =>
  found.some((k) => transientKinds.has(k)) ||
  (found.includes('fetch failed') && !found.some((k) => lastingKinds.has(k)));

/**
 * Runs `operation`; on failure throws a fixed message naming `stage` and the failure's kind. The
 * error is marked `transient` when the connection dropped or stalled (see `retryRead`).
 */
export async function safeRequest(operation, stage = 'request') {
  try {
    return await operation();
  } catch (error) {
    const found = kinds(error);
    const detail = `${stage}${found.length ? `: ${found.join(', ')}` : ''}`;
    // No `cause`: it can hold session headers.
    throw Object.assign(
      new Error(
        `Verification transport failed (${detail}). Request diagnostics suppressed to protect credentials.`,
      ),
      { transient: transient(found), detail },
    );
  }
}

/** Gateway answers that mean the request didn't reach a healthy server; a read can try again. */
const retryableStatus = (status) => [502, 503, 504].includes(status);

/**
 * Runs a read-only (or otherwise idempotent) `operation`, and runs it once more after `pause` ms
 * when it fails with a transient transport error (`safeRequest`'s mark) or an error whose
 * `status` is 502, 503 or 504, or when it resolves to an answer whose `status(result)` is one of
 * them. The retry is logged with `label` and the failure's kind, never a path or a message.
 * Never use it for a write: a write whose outcome is uncertain is reconciled by reading, never
 * repeated.
 */
export async function retryRead(
  operation,
  {
    label = 'read',
    status = () => undefined,
    pause = 2000,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
    log = console.warn,
  } = {},
) {
  let reason;
  try {
    const result = await operation();
    const answered = status(result);
    if (!retryableStatus(answered)) return result;
    reason = `HTTP ${answered}`;
  } catch (error) {
    if (!error?.transient && !retryableStatus(error?.status)) throw error;
    reason = error.transient ? `a transport failure (${error.detail})` : `HTTP ${error.status}`;
  }
  log(`Retrying a ${label} once after ${reason}.`);
  await sleep(pause);
  return operation();
}
