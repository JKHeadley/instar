/**
 * Test-agent leak guard: loadConfig builds `scheduler` field by field, so the
 * allowOnThrowawayAgent override must be carried explicitly or it is dropped.
 * Top-level throwawayAgent / autostart survive load through the spread.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { loadConfig } from '../../src/core/Config.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/Config-throwaway-scheduler.test.ts' }); });

function agent(cfg: Record<string, unknown>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tlg-cfg-'));
  dirs.push(d);
  fs.mkdirSync(path.join(d, '.instar'), { recursive: true });
  fs.writeFileSync(path.join(d, '.instar', 'config.json'), JSON.stringify({ projectName: 'tlg', port: 4999, ...cfg }));
  return d;
}

describe('loadConfig — test-agent leak guard fields', () => {
  it('carries scheduler.allowOnThrowawayAgent: true', () => {
    expect(loadConfig(agent({ scheduler: { allowOnThrowawayAgent: true } })).scheduler.allowOnThrowawayAgent).toBe(true);
  });

  it('leaves it absent otherwise', () => {
    expect(loadConfig(agent({ scheduler: {} })).scheduler.allowOnThrowawayAgent).toBeUndefined();
    expect(loadConfig(agent({ scheduler: { allowOnThrowawayAgent: 'yes' } })).scheduler.allowOnThrowawayAgent).toBeUndefined();
  });

  it('keeps throwawayAgent and autostart', () => {
    const c = loadConfig(agent({ throwawayAgent: { createdAt: 'x', expiresAt: 'y' }, autostart: { autoInstall: false } }));
    expect(c.throwawayAgent?.expiresAt).toBe('y');
    expect(c.autostart?.autoInstall).toBe(false);
  });
});
