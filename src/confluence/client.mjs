import { confluenceTarget } from './target.mjs';
import { retryRead, safeRequest } from '../core/safe-request.mjs';

/**
 * Read-only foundation; writes require future journaled Confluence fixture adapters. A read that
 * fails on transport or with HTTP 502, 503 or 504 runs once more (`retryRead`).
 */
export function client(request, host, { retry = {} } = {}) {
  const target = confluenceTarget(host);
  return async (path) => {
    if (
      typeof path !== 'string' ||
      !/^\/wiki\/(api\/v2|rest\/api)\/[a-zA-Z0-9/_-]+(?:\?[^#\\]*)?$/.test(path) ||
      path.includes('..') ||
      path.includes('://') ||
      [...path].some((c) => c.charCodeAt(0) <= 32)
    )
      throw Error('Invalid Confluence read path.');
    return retryRead(
      async () => {
        const response = await safeRequest(
          () =>
            request.fetch(`${target.site}${path}`, {
              method: 'GET',
              timeout: 30_000,
              maxRedirects: 0,
            }),
          'Confluence GET fetch',
        );
        if (!response.ok())
          throw Object.assign(
            Error(
              `Confluence GET failed (HTTP ${response.status()}); visibility is not established.`,
            ),
            { status: response.status() },
          );
        return safeRequest(() => response.json(), 'Confluence GET JSON parse');
      },
      { label: 'Confluence GET', ...retry },
    );
  };
}
