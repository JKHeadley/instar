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
});
