import { describe, it, expect, vi } from 'vitest';

const calls: Array<{ cmd: string; args: string[] }> = [];
vi.mock('node:child_process', () => ({
  execFile: vi.fn((cmd: string, args: string[], _o: unknown, cb: (e: Error | null, out?: string) => void) => {
    calls.push({ cmd, args });
    cb(cmd === 'sudo' && args.includes('fail-me') ? new Error('no') : null, '2.1.316 (Claude Code)');
  }),
  spawn: vi.fn(),
}));

import { claudeMeetsFloor, installSandboxPackages } from '../../src/core/memorySandboxProbe.js';

describe('installSandboxPackages', () => {
  it('never prompts: it uses sudo -n and installs both tools', async () => {
    expect(await installSandboxPackages()).toBe(true);
    const call = calls[calls.length - 1];
    expect(call.cmd).toBe('sudo');
    expect(call.args.slice(0, 2)).toEqual(['-n', 'apt-get']);
    expect(call.args).toEqual(expect.arrayContaining(['bubblewrap', 'socat']));
  });
});

describe('claudeMeetsFloor', () => {
  it('accepts the floor and newer, and refuses older or unknown', async () => {
    expect(await claudeMeetsFloor('/c', '2.1.316')).toBe(true);
    expect(await claudeMeetsFloor('/c', '2.1.300')).toBe(true);
    expect(await claudeMeetsFloor('/c', '2.2.0')).toBe(false);
    expect(await claudeMeetsFloor(undefined, '2.1.316')).toBe(false);
  });
});
