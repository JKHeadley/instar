/**
 * E2E test — Telegraph publishing flow.
 *
 * Makes REAL API calls to telegra.ph to verify the full pipeline:
 *   markdown → Node conversion → publish → verify URL → edit → verify
 *
 * These tests create real pages on Telegraph. Telegraph pages are
 * free, have no rate limits, and don't expire — so this is safe to run.
 *
 * Skip with: SKIP_E2E=1 npx vitest run --config vitest.e2e.config.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TelegraphService } from '../../src/publishing/TelegraphService.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SKIP = process.env.SKIP_E2E === '1';

/**
 * Telegraph's public API occasionally returns transient errors (PAGE_SAVE_FAILED,
 * network blips, 5xx, rate-limit) that are no fault of ours. Those must NOT fail
 * the build on unrelated PRs — a transient external hiccup once failed CI on a
 * Gemini quota change that touches zero Telegraph code. Retry a few times with
 * backoff, then fail only if the service is genuinely down. Non-transient errors
 * (real bugs / assertion-worthy failures) throw immediately so they still surface.
 */
const TRANSIENT_API_ERROR =
  /PAGE_SAVE_FAILED|FLOOD_WAIT|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network|fetch failed|\b5\d\d\b|\b429\b/i;

async function withTransientRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!TRANSIENT_API_ERROR.test(msg)) throw err; // real failure — surface immediately
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw new Error(
    `Telegraph ${label} failed after ${attempts} attempts (transient external API): ` +
      `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

describe('Telegraph E2E publish flow', () => {
  let stateDir: string;
  let service: TelegraphService;

  beforeAll(() => {
    if (SKIP) return;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-telegraph-e2e-'));
    service = new TelegraphService({
      stateDir,
      shortName: 'instar-test',
      authorName: 'Instar E2E Test',
    });
  });

  afterAll(() => {
    if (SKIP) return;
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/e2e/telegraph-publish.test.ts:38' });
  });

  it.skipIf(SKIP)('creates a Telegraph account', async () => {
    const token = await withTransientRetry('ensureAccount', () => service.ensureAccount());
    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');

    // Subsequent calls return the same token
    const token2 = await withTransientRetry('ensureAccount', () => service.ensureAccount());
    expect(token2).toBe(token);
  });

  it.skipIf(SKIP)('publishes a markdown page', async () => {
    const markdown = [
      '# E2E Test Page',
      '',
      'This page was automatically created by the Instar E2E test suite.',
      '',
      '## Features Tested',
      '',
      '- **Bold text** formatting',
      '- *Italic text* formatting',
      '- `Inline code` formatting',
      '- [Links](https://instar.sh) work correctly',
      '',
      '### Code Block',
      '',
      '```',
      'const greeting = "Hello from Instar!";',
      'console.log(greeting);',
      '```',
      '',
      '> This is a blockquote demonstrating all formatting options.',
      '',
      '---',
      '',
      '1. First ordered item',
      '2. Second ordered item',
      '3. Third ordered item',
      '',
      'Final paragraph with ~~strikethrough~~ text.',
    ].join('\n');

    const page = await withTransientRetry('publishPage', () => service.publishPage('Instar E2E Test', markdown));

    expect(page.url).toMatch(/^https:\/\/telegra\.ph\//);
    expect(page.path).toBeTruthy();
    expect(page.title).toBe('Instar E2E Test');

    // Verify the page is accessible
    const response = await fetch(page.url);
    expect(response.ok).toBe(true);

    // Verify local tracking
    const pages = service.listPages();
    expect(pages.length).toBeGreaterThanOrEqual(1);
    const tracked = pages.find(p => p.path === page.path);
    expect(tracked).toBeDefined();
    expect(tracked!.title).toBe('Instar E2E Test');
  });

  it.skipIf(SKIP)('edits a published page', async () => {
    // Publish first
    const original = await withTransientRetry('publishPage', () => service.publishPage('Edit Test', '# Original\n\nOriginal content.'));

    // Edit it
    const updated = await withTransientRetry('editPage', () => service.editPage(
      original.path,
      'Edit Test (Updated)',
      '# Updated\n\nThis content has been updated by the E2E test.',
    ));

    expect(updated.url).toMatch(/^https:\/\/telegra\.ph\//);
    expect(updated.title).toBe('Edit Test (Updated)');

    // Verify the edit was tracked
    const pages = service.listPages();
    const tracked = pages.find(p => p.path === original.path);
    expect(tracked).toBeDefined();
    expect(tracked!.title).toBe('Edit Test (Updated)');
    expect(tracked!.updatedAt).toBeTruthy();
  });

  it.skipIf(SKIP)('gets page views', async () => {
    // Use a page we just created
    const pages = service.listPages();
    expect(pages.length).toBeGreaterThan(0);

    const views = await withTransientRetry('getPageViews', () => service.getPageViews(pages[0].path));
    expect(typeof views).toBe('number');
    expect(views).toBeGreaterThanOrEqual(0);
  });

  it.skipIf(SKIP)('persists state across service instances', async () => {
    const pages1 = service.listPages();
    expect(pages1.length).toBeGreaterThan(0);

    // Create a new service instance pointing to same state
    const service2 = new TelegraphService({
      stateDir,
      shortName: 'instar-test',
    });

    const pages2 = service2.listPages();
    expect(pages2.length).toBe(pages1.length);
    expect(pages2[0].path).toBe(pages1[0].path);

    // Token should be reused
    const state = service2.getState();
    expect(state.accessToken).toBeTruthy();
  });
});
