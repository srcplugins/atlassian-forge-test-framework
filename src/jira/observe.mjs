// Observe one Forge resolver response (a { ok, value | error } envelope) for an explicit
// installation target: the action's function key, environment and app must all match.

function envelope(value) {
  if (typeof value === 'string') {
    try {
      return envelope(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  if (typeof value.ok === 'boolean' && ('value' in value || 'error' in value)) return value;
  for (const child of Object.values(value)) {
    const found = envelope(child);
    if (found) return found;
  }
  return null;
}
export async function observeAction(page, action, exercise, target, projectId) {
  let result;
  const response = page.waitForResponse(
    async (response) => {
      try {
        const input = response.request().postDataJSON()?.variables?.input;
        if (
          input?.payload?.call?.functionKey !== action ||
          input.payload.context?.environmentId !== target.environmentId ||
          !input.extensionId?.includes(target.appId)
        )
          return false;
        // Consume the body before a successful save can reload the host page.
        const candidate = envelope(await response.json());
        if (projectId && candidate?.value?.project?.id !== projectId) return false;
        result = candidate;
        return true;
      } catch {
        return false;
      }
    },
    { timeout: 45_000 },
  );
  await Promise.all([response, exercise()]);
  if (!result?.ok) {
    const error = Error(`Resolver ${action} did not return a successful envelope.`);
    error.category = 'resolver-failed';
    throw error;
  }
  return result.value;
}
