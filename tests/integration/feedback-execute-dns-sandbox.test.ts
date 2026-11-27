// safe-fs-allow: test cleanup uses SafeFsExecutor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { buildClaudeSandboxSettings, buildSandboxRuntimeSettings } from '../../src/feedback-factory/execute/executePolicy.js';

describe('feedback executor macOS sandbox', () => {
  it.skipIf(process.platform !== 'darwin')('loads Node DNS configuration in runner and worker sandboxes with empty domain allowlists', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-dns-sandbox-'));
    try {
      const paths = {
        workspace,
        publishClone: `${workspace}-publish`,
        tmpDir: workspace,
        depsCache: path.join(process.cwd(), 'node_modules'),
        agentHome: process.cwd(),
        homeDir: os.homedir(),
        testRunnerHoldersFile: path.join(workspace, 'test-runner-holders.json'),
      };
      const runner = buildSandboxRuntimeSettings(paths);
      const claude = buildClaudeSandboxSettings({ paths, agentHomeChildren: [] }) as { sandbox: { network: typeof runner.network; filesystem: typeof runner.filesystem } };
      const runtime = path.join(process.cwd(), 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'cli.js');
      for (const [name, settings] of [['runner', runner], ['worker', {
        ...runner, network: claude.sandbox.network, filesystem: claude.sandbox.filesystem,
      }]] as const) {
        expect(settings.network.allowedDomains).toEqual([]);
        expect(settings.network.allowLocalBinding).toBe(false);
        expect(settings.network.allowMachLookup).toEqual(['com.apple.SystemConfiguration.DNSConfiguration']);
        const settingsPath = path.join(workspace, `${name}-sandbox-settings.json`);
        fs.writeFileSync(settingsPath, JSON.stringify(settings));
        // A generous limit: this run starts two Node processes and a sandbox on a loaded verifier.
        // A real DNS hang never returns, so it still fails, and the assertion above pins the setting.
        // The sandboxed shell gets no PATH guarantee: a verifier that runs Node by
        // absolute path has no `node` there, so name this test's own interpreter.
        const output = execFileSync(process.execPath, [runtime, '--settings', settingsPath, '-c',
          `${JSON.stringify(process.execPath)} -e "require('node:dns'); process.stdout.write('dns-ready')"`], {
          cwd: workspace, timeout: 45_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        expect(output).toContain('dns-ready');
      }
    } finally {
      SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'tests/integration/feedback-execute-dns-sandbox.test.ts' });
    }
  }, 120_000);

  // fb-c238c6c9-f0d: a Node install under the read-denied home (nvm) could not be found by bash's
  // PATH lookup inside the sandbox ("node: command not found"), although running it by full path
  // worked. A temporary home holds a .nvm-style bin/node link to this Node; PATH names only it.
  it.skipIf(process.platform !== 'darwin')('finds a Node installed under home on PATH only when its install is re-allowed', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-node-home-'));
    try {
      const bin = path.join(home, '.nvm', 'versions', 'node', 'v0', 'bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.symlinkSync(process.execPath, path.join(bin, 'node'));
      const npmrcPath = path.join(bin, '..', 'etc', 'npmrc');
      fs.mkdirSync(path.dirname(npmrcPath));
      fs.writeFileSync(npmrcPath, 'npm-config-marker');
      const workspace = path.join(home, 'agent', '.worktrees', 'w');
      fs.mkdirSync(workspace, { recursive: true });
      const runtime = path.join(process.cwd(), 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'cli.js');
      const run = (nodeExecPath: string, command = 'node -e "process.stdout.write(\'node-found\')"') => {
        const settings = buildSandboxRuntimeSettings({
          workspace, publishClone: `${workspace}-publish`, tmpDir: workspace, depsCache: path.join(process.cwd(), 'node_modules'),
          agentHome: path.join(home, 'agent'), homeDir: home, testRunnerHoldersFile: path.join(workspace, 'h.json'), nodeExecPath,
        });
        const settingsPath = path.join(workspace, `s-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
        fs.writeFileSync(settingsPath, JSON.stringify(settings));
        try {
          return { ok: true, out: execFileSync(process.execPath, [runtime, '--settings', settingsPath, '-c', command], {
            cwd: workspace, timeout: 45_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
          }) };
        } catch (e) { return { ok: false, out: String((e as { stderr?: string }).stderr ?? e) }; }
      };
      // Re-allowed: the install under home is readable, so the PATH lookup finds node.
      const allowed = run(path.join(bin, 'node'));
      expect(allowed.out).toContain('node-found');
      // ...but the install's global npm config, which can carry a registry token, stays unreadable.
      const npmrc = run(path.join(bin, 'node'), `cat '${npmrcPath}'`);
      expect(npmrc.out).not.toContain('npm-config-marker');
      expect(npmrc.ok).toBe(false);
      // Control: outside the sandbox the same file is readable, so the refusal above is the sandbox's.
      expect(fs.readFileSync(npmrcPath, 'utf8')).toBe('npm-config-marker');
      // Not re-allowed (the binary is reported outside home): the same lookup fails as on the M5.
      const denied = run('/usr/local/bin/node');
      expect(denied.ok).toBe(false);
      expect(denied.out).toMatch(/node: command not found|Operation not permitted/);
    } finally {
      SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/integration/feedback-execute-dns-sandbox.test.ts:node-home' });
    }
  }, 120_000);
});
