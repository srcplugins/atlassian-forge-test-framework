import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test as base, expect } from './features.mjs';
import { client } from './client.mjs';
import { activeTarget } from '../core/target.mjs';

// The owner's Jira theme preference, journaled and restored. Its menu is in Jira's account menu,
// reached from any Jira page; `themePage` is a site-relative path.
export const test = base.extend({
  themePage: ['/jira/your-work', { option: true }],
  theme: async ({ page, context, jiraRequest, themePage }, use) => {
    if (typeof themePage !== 'string' || !themePage.startsWith('/'))
      throw Error('themePage must be a site-relative path, for example /jira/your-work.');
    const open = () =>
      page.goto(`${activeTarget().site}${themePage}`, { waitUntil: 'domcontentloaded' });
    const owner = await client(jiraRequest)('/myself');
    expect((await client(context.request)('/myself')).accountId).toBe(owner.accountId);
    expect(owner.emailAddress).toBeTruthy();
    const directory = activeTarget().results('appearance');
    mkdirSync(directory, { recursive: true });
    for (const name of readdirSync(directory).filter((name) => name.endsWith('.json')))
      if (JSON.parse(readFileSync(`${directory}/${name}`)).status !== 'restored')
        throw Error(
          'Unrestored theme journal; restore the recorded preference before another run.',
        );
    // Serial lane only. Refuse another process before any preference change.
    const lock = `${directory}/theme.lock`;
    if (existsSync(lock)) throw Error('Appearance preference is locked.');
    writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
    const { unlinkSync } = await import('node:fs');
    const path = `${directory}/${randomUUID()}.json`;
    let receipt;
    const viewport = page.viewportSize();
    const save = () => {
      writeFileSync(`${path}.tmp`, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    };
    async function menu() {
      if (!(await page.getByRole('button', { name: 'Theme', exact: true }).isVisible()))
        await page.getByRole('button', { name: owner.emailAddress, exact: true }).click();
      const choices = page.getByRole('menuitemradio');
      if (!(await choices.first().isVisible()))
        await page.getByRole('button', { name: 'Theme', exact: true }).click();
      await expect(choices).toHaveCount(3, { timeout: 5000 });
      return choices;
    }
    // Theme is a flyout that can close between two steps on a slower host (GitHub's runners),
    // so each step that needs a choice reopens the menu until it can act on it.
    async function onChoice(item, act) {
      await expect(async () => {
        await menu();
        await act(item);
      }).toPass({ timeout: 30000, intervals: [500, 1000, 2000] });
    }
    async function set(name) {
      if (!['Light', 'Dark', 'Match browser'].includes(name)) throw Error('Unsupported theme');
      // Choosing the same theme twice is harmless, so a click lost to a closing flyout repeats.
      await onChoice(page.getByRole('menuitemradio', { name, exact: true }), (item) =>
        item.click({ timeout: 3000 }),
      );
      if (name !== 'Match browser')
        await expect(page.locator('html')).toHaveAttribute('data-color-mode', name.toLowerCase());
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
    }
    try {
      await open();
      const selected = page.getByRole('menuitemradio', { checked: true });
      let original;
      await onChoice(selected, async (item) => {
        await expect(item).toHaveCount(1, { timeout: 3000 });
        original = (await item.innerText({ timeout: 3000 })).trim();
      });
      expect(['Light', 'Dark', 'Match browser']).toContain(original);
      receipt = {
        site: activeTarget().site,
        actor: owner.accountId,
        original,
        status: 'restore-required',
      };
      save(); // Intent before any theme mutation.
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await use(set);
    } finally {
      if (receipt) {
        // The theme menu is in the account menu, which narrow layouts collapse.
        await page.setViewportSize(viewport);
        await open();
        await set(receipt.original);
        await onChoice(
          page.getByRole('menuitemradio', { name: receipt.original, exact: true }),
          (item) => expect(item).toHaveAttribute('aria-checked', 'true', { timeout: 3000 }),
        );
        receipt.status = 'restored';
        save();
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
      }
      unlinkSync(lock);
    }
  },
});

export async function textContrast(locator) {
  const colors = await locator.evaluate((element) => {
    const color = getComputedStyle(element).color;
    let node = element;
    let background = 'rgba(0, 0, 0, 0)';
    while (node && background === 'rgba(0, 0, 0, 0)') {
      background = getComputedStyle(node).backgroundColor;
      node = node.parentElement;
    }
    return { color, background };
  });
  function luminance(value) {
    const match = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(value);
    expect(match, `Opaque resolved color required: ${value}`).toBeTruthy();
    const channels = match.slice(1).map((x) => {
      const c = Number(x) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  const a = luminance(colors.color);
  const b = luminance(colors.background);
  expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
}
