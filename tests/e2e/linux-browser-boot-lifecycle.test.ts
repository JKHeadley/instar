/**
 * The feature is alive through the production path: the boot wiring calls the real module after the port
 * binds, a new agent gets the marker, and a non-Linux host writes nothing. Spec: docs/specs/normal-chrome-linux.md.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as provision from '../../src/core/linuxBrowserProvision.js';
import { isBlankAgentHome, markNewAgent } from '../../src/recommended/offerPrerequisites.js';

describe('Linux browser boot wiring', () => {
  const server = fs.readFileSync(path.resolve('src/commands/server.ts'), 'utf8');

  it('runs after the port binds, from the real module, never awaited', () => {
    const started = server.indexOf('await server.start();');
    const called = server.indexOf('void provisionLinuxBrowser(browserDeps());');
    expect(started).toBeGreaterThan(-1);
    expect(called).toBeGreaterThan(started);
    expect(server).toContain("await import('../core/linuxBrowserProvision.js')");
    expect(provision.provisionLinuxBrowser).toBeTypeOf('function');
  });

  it('marks a blank agent home on creation, and that marker is what the rule reads', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbb-'));
    expect(isBlankAgentHome(stateDir)).toBe(true);
    markNewAgent(stateDir);
    expect(provision.wantsAutoInstall(stateDir, undefined, false)).toBe(true);
  });

  it('answers a state on this host through the real function and writes nothing when not Linux', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbb-'));
    expect(['ready', 'installing', 'not-built', 'broken']).toContain(provision.browserCapability(stateDir).state);
    if (process.platform !== 'linux') {
      await provision.provisionLinuxBrowser({ stateDir, projectDir: stateDir, configured: true, throwaway: false });
      expect(fs.existsSync(path.join(stateDir, 'state', 'xdrive'))).toBe(false);
    }
  });
});
