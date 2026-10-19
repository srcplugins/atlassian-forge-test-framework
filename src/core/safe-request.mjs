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
];
const names = ['AbortError', 'TimeoutError', 'SyntaxError', 'TypeError'];

/** The kind of a transport failure, taken only from the fixed lists; never its text. */
function kind(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const cause = error?.cause;
  const code = [error?.code, cause?.code].find((c) => codes.includes(c));
  const found = [
    names.includes(error?.name) && error.name,
    code ?? codes.find((c) => new RegExp(`\\b${c}\\b`).test(message)),
    phrases.find(([pattern]) => pattern.test(message))?.[1],
  ].filter(Boolean);
  return [...new Set(found)].join(', ');
}

/** Runs `operation`; on failure throws a fixed message naming `stage` and the failure's kind. */
export async function safeRequest(operation, stage = 'request') {
  try {
    return await operation();
  } catch (error) {
    const detail = kind(error);
    // eslint-disable-next-line preserve-caught-error -- The cause can hold session headers.
    throw new Error(
      `Verification transport failed (${stage}${detail ? `: ${detail}` : ''}). Request diagnostics suppressed to protect credentials.`,
    );
  }
}
