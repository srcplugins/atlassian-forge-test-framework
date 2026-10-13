/** Completes Jira's first-run onboarding dialog whenever it appears. */
export async function dismissOnboarding(page) {
  const onboarding = page.getByRole('dialog').filter({
    has: page.getByRole('heading', {
      name: /^(How we use Jira|Build and deliver products with Jira)$/,
    }),
  });
  await page.addLocatorHandler(onboarding, async () => {
    // The first step's button is "Next" or "Next step", depending on the Jira version.
    if (await onboarding.getByRole('heading', { name: 'How we use Jira', exact: true }).isVisible())
      await onboarding.getByRole('button', { name: /^Next( step)?$/ }).click();
    await onboarding.getByRole('button', { name: 'Done', exact: true }).click();
  });
}
