import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dashboardPreviewDir, publishDashboardPreview } from '../../src/server/dashboardPreview.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
function tmp(prefix: string): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'dashboard-preview unit cleanup' }); });

function source(text: string): string {
  const d = tmp('preview-src-');
  fs.writeFileSync(path.join(d, 'index.html'), `<p>${text}</p>`);
  fs.mkdirSync(path.join(d, 'fonts'));
  fs.writeFileSync(path.join(d, 'fonts', 'a.woff2'), 'font');
  return d;
}
const meta = { branch: 'echo/x', commit: 'abc1234', uncommitted: false, publishedAt: '2026-10-31T19:00:00.000Z' };

describe('publishDashboardPreview', () => {
  it('copies the pages into the state folder with a preview.json saying which work it is', () => {
    const state = tmp('preview-state-');
    const dir = publishDashboardPreview(state, source('one'), meta);
    expect(dir).toBe(dashboardPreviewDir(state));
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe('<p>one</p>');
    expect(fs.readFileSync(path.join(dir, 'fonts', 'a.woff2'), 'utf8')).toBe('font');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'preview.json'), 'utf8'))).toEqual(meta);
  });
  it('replaces the previous copy completely and leaves no staging folders behind', () => {
    const state = tmp('preview-state-');
    publishDashboardPreview(state, source('one'), meta);
    fs.writeFileSync(path.join(dashboardPreviewDir(state), 'stale.js'), 'old');
    publishDashboardPreview(state, source('two'), { ...meta, commit: 'def5678' });
    const dir = dashboardPreviewDir(state);
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe('<p>two</p>');
    expect(fs.existsSync(path.join(dir, 'stale.js'))).toBe(false);
    expect(fs.readdirSync(state).sort()).toEqual(['dashboard-preview']);
  });
  it('refuses a folder that is not a console (no index.html) and keeps the current preview', () => {
    const state = tmp('preview-state-');
    publishDashboardPreview(state, source('one'), meta);
    expect(() => publishDashboardPreview(state, tmp('empty-'), meta)).toThrow(/no index\.html/);
    expect(fs.readFileSync(path.join(dashboardPreviewDir(state), 'index.html'), 'utf8')).toBe('<p>one</p>');
  });
});
