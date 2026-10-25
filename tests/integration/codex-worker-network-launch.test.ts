import { describe, expect, it } from 'vitest';
import { buildHeadlessLaunch } from '../../src/core/frameworkSessionLaunch.js';

describe('Codex headless worker network launch — integration', () => {
  it('overrides a conflicting machine config while retaining workspace-write', () => {
    // A user config containing `network_access = false` is deliberately modeled
    // by the first value. Codex CLI applies repeated config sources in order;
    // the invocation-level -c is the final, authoritative value.
    const machineConfig = { sandbox_workspace_write: { network_access: false } };
    const launch = buildHeadlessLaunch('codex-cli', {
      binaryPath: '/usr/local/bin/codex', prompt: 'curl the local API',
    });
    const overrideIndex = launch.argv.indexOf('-c');
    const invocationValue = launch.argv[overrideIndex + 1];

    expect(machineConfig.sandbox_workspace_write.network_access).toBe(false); // control
    expect(invocationValue).toBe('sandbox_workspace_write.network_access=true');
    expect(launch.argv.slice(launch.argv.indexOf('-s'), launch.argv.indexOf('-s') + 2))
      .toEqual(['-s', 'workspace-write']);
    expect(launch.argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('does not attach the grant to intentionally unsandboxed reply workers', () => {
    const launch = buildHeadlessLaunch('codex-cli', {
      binaryPath: '/usr/local/bin/codex', prompt: 'reply', codexAllowMcpTools: true,
    });
    expect(launch.argv).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(launch.argv).not.toContain('sandbox_workspace_write.network_access=true');
  });
});
