/**
 * Smoke tests for the Secrets dashboard tab.
 *
 * Inspects the HTML/JS at rest (no browser execution). Verifies tab wiring,
 * panel presence, loader defined, expected endpoint usage, and XSS-safe
 * rendering (no innerHTML assignment in the loader body).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.resolve(__dirname, '../../dashboard/index.html'), 'utf-8');

describe('dashboard: Secrets tab', () => {
  it('has a Secrets tab button wired to switchTab', () => {
    expect(HTML).toContain('data-tab="secrets"');
    expect(HTML).toContain(`switchTab('secrets')`);
  });

  it('has a secretsPanel that renders through the shared glance component (Phase 4)', () => {
    expect(HTML).toContain('id="secretsPanel"');
    expect(HTML).toMatch(/id="secretsGlance"[^>]*class="glance-root"/);
  });

  it('has a tabSecretCount badge on the tab button', () => {
    expect(HTML).toContain('id="tabSecretCount"');
  });

  it('registers the secrets tab in TAB_REGISTRY', () => {
    expect(HTML).toMatch(/id:\s*'secrets'[\s\S]{0,200}panels:\s*\['secretsPanel'\]/);
  });

  it('calls loadSecrets on activation (Phase 4 retired the live countdown ticker)', () => {
    expect(HTML).toContain(`loadSecrets === 'function'`);
    // The glance shows a static expiry at Layer 3, so the secrets tab no longer
    // starts a 1s countdown ticker on activate.
    const reg = HTML.match(/id:\s*'secrets'[\s\S]{0,300}/)![0];
    expect(reg).not.toContain('startSecretsTicker()');
  });

  it('defines async function loadSecrets', () => {
    expect(HTML).toMatch(/async function loadSecrets\(\)/);
  });

  it('fetches /secrets/pending', () => {
    const start = HTML.indexOf('async function loadSecrets()');
    const body = HTML.slice(start, start + 6000);
    expect(body).toContain(`'/secrets/pending'`);
  });

  it('defines createTestSecretRequest posting to /secrets/request', () => {
    expect(HTML).toMatch(/async function createTestSecretRequest\(\)/);
    const start = HTML.indexOf('async function createTestSecretRequest()');
    const body = HTML.slice(start, start + 2000);
    expect(body).toContain(`'/secrets/request'`);
    expect(body).toContain(`method: 'POST'`);
  });

  it('supports cancelling a pending request via DELETE /secrets/pending/:token', () => {
    // Phase 4: the cancel action moved to the shared cancelSecretRequest helper,
    // wired onto the glance's Layer-3 record via onCancel (behavior preserved).
    const start = HTML.indexOf('async function cancelSecretRequest(');
    expect(start).toBeGreaterThan(-1);
    const body = HTML.slice(start, start + 800);
    expect(body).toMatch(/\/secrets\/pending\/\$\{encodeURIComponent\(token\)\}/);
    expect(body).toMatch(/method:\s*'DELETE'/);
    // loadSecrets passes cancelSecretRequest through as onCancel.
    const lsStart = HTML.indexOf('async function loadSecrets()');
    expect(HTML.slice(lsStart, lsStart + 1200)).toContain('onCancel: cancelSecretRequest');
  });

  it('does not use innerHTML inside loadSecrets (XSS invariant)', () => {
    const start = HTML.indexOf('async function loadSecrets()');
    const rest = HTML.slice(start + 1);
    const nextFn = rest.search(/\n\s*(async )?function \w+\(/);
    const body = rest.slice(0, nextFn);
    expect(body).not.toMatch(/\.innerHTML\s*=/);
  });

  it('ticker functions are defined and use setInterval / clearInterval', () => {
    expect(HTML).toMatch(/function startSecretsTicker\(\)/);
    expect(HTML).toMatch(/function stopSecretsTicker\(\)/);
    const start = HTML.indexOf('function startSecretsTicker()');
    const body = HTML.slice(start, start + 1000);
    expect(body).toContain('setInterval');
  });

  it('renders through the glance component (Phase 4 — static expiry replaces the live countdown)', () => {
    const start = HTML.indexOf('async function loadSecrets()');
    const body = HTML.slice(start, start + 1200);
    // The tab builds its glance via the shared component; the exact expiry time
    // is shown at Layer 3 (a static timestamp), so no per-item live countdown.
    expect(body).toContain('secretsGlanceSpec');
    expect(body).toContain('renderGlance');
  });
});
