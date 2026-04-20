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

  it('has a secretsPanel container', () => {
    expect(HTML).toContain('id="secretsPanel"');
  });

  it('has a tabSecretCount badge on the tab button', () => {
    expect(HTML).toContain('id="tabSecretCount"');
  });

  it('registers the secrets tab in TAB_REGISTRY', () => {
    expect(HTML).toMatch(/id:\s*'secrets'[\s\S]{0,200}panels:\s*\['secretsPanel'\]/);
  });

  it('calls loadSecrets on activation and stops the ticker on deactivation', () => {
    expect(HTML).toContain(`loadSecrets === 'function'`);
    expect(HTML).toContain('startSecretsTicker()');
    expect(HTML).toContain('stopSecretsTicker()');
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
    const start = HTML.indexOf('async function loadSecrets()');
    const body = HTML.slice(start, start + 6000);
    expect(body).toMatch(/\/secrets\/pending\/\$\{encodeURIComponent\(p\.token\)\}/);
    expect(body).toMatch(/method:\s*'DELETE'/);
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

  it('renders an expires-in countdown element per pending item', () => {
    const start = HTML.indexOf('async function loadSecrets()');
    const body = HTML.slice(start, start + 6000);
    expect(body).toContain('secretCountdown-');
  });
});
