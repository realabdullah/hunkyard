import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { fixtureStatePath } from './runtime-path';

const execute = promisify(execFile);
test('critical review flow passes automated AA checks, keyboard anchors, bounded large diff and narrow reflow', async ({
  page,
}, testInfo) => {
  const fixture = JSON.parse(await readFile(fixtureStatePath, 'utf8')) as {
    root: string;
    token: string;
  };
  const audit = async () => {
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      results.violations.map((entry) => ({
        id: entry.id,
        nodes: entry.nodes.map((node) => node.target),
      })),
    ).toEqual([]);
  };
  await page.goto('/');
  await audit();
  await page.getByLabel('API connection token').fill(fixture.token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: 'Model & privacy' }).click();
  await audit();
  await page.getByRole('button', { name: 'Review workspace', exact: true }).click();
  const source = join(fixture.root, 'example.ts');
  const original = await readFile(source, 'utf8');
  const index = (await execute('git', ['show', ':example.ts'], { cwd: fixture.root })).stdout;
  try {
    await writeFile(
      source,
      `export const divide = (value: number) => value / 0;\n${Array.from({ length: 10000 }, (_, i) => `// ${i}`).join('\n')}\n`,
    );
    await execute('git', ['add', 'example.ts'], { cwd: fixture.root });
    await page.getByLabel('Token budget override (empty uses profile default)').fill('200000');
    const started = Date.now();
    await page.getByRole('button', { name: 'Review staged changes', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Diff pages' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Division by zero', exact: true }),
    ).toBeVisible();
    const latencyMs = Date.now() - started;
    expect(await page.locator('.diff > span').count()).toBeLessThanOrEqual(300);
    await page.getByRole('button', { name: 'Next diff page' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('navigation', { name: 'Diff pages' })).toContainText('Page 2 of');
    await page.getByRole('button', { name: 'example.ts:1 (new)', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[id="new:example.ts:1"]')).toBeFocused();
    await page.getByRole('button', { name: 'Next diff page' }).click();
    await page.getByRole('button', { name: 'example.ts:1 (new)', exact: true }).click();
    await expect(page.locator('[id="new:example.ts:1"]')).toBeFocused();
    await audit();
    await page.setViewportSize({ width: 320, height: 800 });
    await audit();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
    await page.screenshot({ path: 'test-results/phase-seven-narrow.png', fullPage: true });
    await writeFile(
      'test-results/phase-seven-performance.json',
      JSON.stringify(
        {
          lines: 10000,
          renderedLineLimit: 300,
          clickToFindingMs: latencyMs,
          platform: process.platform,
        },
        null,
        2,
      ),
    );
    await testInfo.attach('large-diff-profile', {
      body: JSON.stringify({
        lines: 10000,
        renderedLineLimit: 300,
        clickToFindingMs: latencyMs,
        platform: process.platform,
      }),
      contentType: 'application/json',
    });
  } finally {
    await writeFile(source, index);
    await execute('git', ['add', 'example.ts'], { cwd: fixture.root });
    await writeFile(source, original);
  }
});
