import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';

// Supervised acceptance only. Jira facts, not agent prose, establish mutation results.
export async function openRovoChat(page, { url, agent, starter, inventory }) {
  const gallery = async () => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Jira remembers an open chat panel across page loads and restores it after the top bar
    // renders, sometimes seconds later; opening it again would close it. Give the panel time
    // to appear, then open it until its menu shows (a click that closed a late panel reopens it).
    // Narrower windows label the chat button "Ask Rovo".
    const menu = page.getByRole('button', { name: 'Menu', exact: true });
    const open = page
      .getByRole('button', { name: 'Open Rovo Chat', exact: true })
      .or(page.getByRole('button', { name: 'Ask Rovo', exact: true }))
      .first();
    await expect(menu.or(open).first()).toBeVisible({ timeout: 45000 });
    await menu.waitFor({ timeout: 10000 }).catch(() => {});
    await expect(async () => {
      if (!(await menu.isVisible())) await open.click({ timeout: 5000 });
      await expect(menu).toBeVisible({ timeout: 10000 });
    }).toPass({ timeout: 60000, intervals: [1000, 3000] });
    await menu.click();
    await page.getByText('View all agents', { exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search agents', exact: true }).fill(agent);
    const choices = page.getByRole('button', { name: `Chat with ${agent}`, exact: true });
    await expect(choices.first()).toBeVisible();
    // The gallery fills in as results arrive: one of two same-named agents shows first, the
    // other a moment later. Count only once the list holds steady.
    await settledCount(choices);
    return choices;
  };
  const select = async (choices, index) => {
    await choices.nth(index).click();
    // The title changes before agent selection completes. The starter is the readiness gate.
    await expect(page.getByText(starter, { exact: true })).toBeVisible({ timeout: 45000 });
    await expect(rovoComposer(page)).toHaveCount(1);
  };
  let choices = await gallery();
  const count = await choices.count();
  if (count === 1) {
    await select(choices, 0);
    if (inventory) expect(inventory.matches(await askRovo(page, inventory.prompt))).toBe(true);
    return;
  }
  // Jira's gallery gives installed environments identical names and no environment badge.
  // Probe only read-only inventory against an independently prepared unique fixture.
  // Never prepare a draft or confirm an action while selection is ambiguous.
  if (count > 3 || !inventory)
    throw Error('Ambiguous agent environment; verified inventory required');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(url).origin,
  });
  const identifiers = async (buttons) => {
    const ids = [];
    for (let index = 0; index < count; index++) {
      ids.push(
        await copyAgentProfile(
          page,
          buttons
            .nth(index)
            .locator('..')
            .getByRole('button', { name: `Copy link to ${agent}`, exact: true }),
        ),
      );
    }
    expect(new Set(ids).size).toBe(count);
    return ids;
  };
  const ids = await identifiers(choices);
  const matches = [];
  for (let index = 0; index < ids.length; index++) {
    if (index) choices = await gallery();
    await expect(choices).toHaveCount(count);
    const current = await identifiers(choices);
    const selected = current.indexOf(ids[index]);
    expect(selected).toBeGreaterThanOrEqual(0);
    await select(choices, selected);
    const response = await askRovo(page, inventory.prompt);
    await inventory.capture?.(ids[index], response);
    if (inventory.matches(response)) matches.push(ids[index]);
  }
  expect(matches).toHaveLength(1);
  choices = await gallery();
  await expect(choices).toHaveCount(count);
  const selected = (await identifiers(choices)).indexOf(matches[0]);
  expect(selected).toBeGreaterThanOrEqual(0);
  await select(choices, selected);
  expect(inventory.matches(await askRovo(page, inventory.prompt))).toBe(true);
}
/**
 * Waits until a locator's count is the same on two reads `poll.intervals` apart, and returns it.
 * `poll` overrides the wait (Playwright expect.poll timeout/intervals) for offline tests.
 */
export async function settledCount(locator, poll = { timeout: 15000, intervals: [1500] }) {
  let last = -1;
  let count;
  await expect
    .poll(
      async () => {
        count = await locator.count();
        const steady = count === last;
        last = count;
        return steady;
      },
      { ...poll, message: 'The agent gallery kept changing' },
    )
    .toBe(true);
  return count;
}
const rovoComposer = (page) =>
  page.getByRole('textbox').and(page.locator('[contenteditable="true"]'));
export async function askRovo(page, prompt, { capture = async () => {} } = {}) {
  try {
    await expect(rovoComposer(page)).toHaveCount(1);
    await rovoComposer(page).fill(prompt);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Stop generating', exact: true }).first(),
    ).toBeVisible({ timeout: 45000 });
    await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(
      0,
      { timeout: 180000 },
    );
    return (await page.locator('body').innerText()).split(prompt).at(-1);
  } finally {
    await capture('response');
  }
}

// A successful click can precede the asynchronous clipboard write. Seed a unique
// value so even an unchanged profile link must be freshly copied by this click.
// `poll` overrides the wait (Playwright expect.poll timeout/intervals) for offline tests.
export async function copyAgentProfile(page, button, poll = { timeout: 5000 }) {
  const pending = `forge-test-copy-pending:${randomUUID()}`;
  await page.evaluate((value) => navigator.clipboard.writeText(value), pending);
  await button.click();
  let copied;
  await expect
    .poll(
      async () => {
        copied = await page.evaluate(() => navigator.clipboard.readText());
        return copied !== pending;
      },
      { ...poll, message: 'Agent Copy link did not complete' },
    )
    .toBe(true);
  const link = new URL(copied);
  expect(link.origin).toBe('https://home.atlassian.com');
  expect(link.pathname).toMatch(/^(?:\/o\/[0-9a-f-]{36})?\/people\/agent\/[0-9a-f-]{36}$/);
  expect(link.username + link.password).toBe('');
  return link.pathname;
}
