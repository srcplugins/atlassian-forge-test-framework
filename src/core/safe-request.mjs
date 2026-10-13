// Browser/API exceptions can contain session headers. Keep raw causes out of reports.
export async function safeRequest(operation) {
  try {
    return await operation();
  } catch {
    throw new Error(
      'Verification transport failed. Request diagnostics suppressed to protect credentials.',
    );
  }
}
