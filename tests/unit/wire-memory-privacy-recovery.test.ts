/**
 * Wiring with real executables at the versions from the Indra report: the configured
 * binary below the floor, a working one elsewhere, and a real config file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wireMemoryPrivacy } from '../../src/users/wireMemoryPrivacy.js';
import { memorySandboxWorks } from '../../src/core/memorySandboxProbe.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { SessionManager } from '../../src/core/SessionManager.js';

vi.mock('../../src/core/memorySandboxProbe.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/memorySandboxProbe.js')>()),
  memorySandboxWorks: vi.fn(async () => true),
}));

describe('wireMemoryPrivacy recovery', () => {
  let dir: string;
  let setClaudeBinary: ReturnType<typeof vi.fn>;
  let captured: { blocker?: () => string | null; fix?: () => string | null; sandboxReady: () => boolean };
  const binary = (name: string, version: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\necho "${version} (Claude Code)"\n`, { mode: 0o755 });
    return file;
  };
  const wire = (claudePath: string | undefined, candidates: string[]) => wireMemoryPrivacy({
    projectDir: dir, stateDir: path.join(dir, '.instar'), projectName: 'indra', instarRoot: dir,
    framework: () => 'claude-code', memoryPrivacy: () => ({ enabled: true, ownerUserId: 'justin' }), messaging: () => [],
    claudePath, claudeCandidates: candidates, linkFor: (p) => `https://t.example${p}`,
    sessionManager: {
      setMemoryPrivacy: (w: typeof captured) => { captured = w; }, setClaudeBinary,
    } as unknown as SessionManager,
  });
  const config = () => JSON.parse(fs.readFileSync(path.join(dir, '.instar', 'config.json'), 'utf8'));
  const tokenIn = (t: string) => /fix\/([A-Za-z0-9_-]{43})/.exec(t)?.[1] ?? '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-memory-'));
    fs.mkdirSync(path.join(dir, '.instar'));
    fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify({ projectName: 'indra', sessions: { claudePath: '/old', maxSessions: 3 } }));
    setClaudeBinary = vi.fn();
    vi.mocked(memorySandboxWorks).mockResolvedValue(true);
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/wire-memory-privacy-recovery.test.ts' }));

  it('names a binary below the floor as the cause, not the platform', async () => {
    const w = wire(binary('old', '2.1.300'), [binary('new', '2.1.318')]);
    await w.ready;
    expect(captured.sandboxReady()).toBe(false);
    expect(captured.blocker?.()).toBe('claude-too-old');
    expect(captured.fix?.()).toContain('2.1.300');
  });

  it('is ready with no blocker when the binary meets the floor', async () => {
    const w = wire(binary('ok', '2.1.316'), []);
    await w.ready;
    expect(captured.sandboxReady()).toBe(true);
    expect(captured.blocker?.()).toBeNull();
  });

  it('a binary that will not run is reported as that', async () => {
    const w = wire(path.join(dir, 'gone'), []);
    await w.ready;
    expect(captured.blocker?.()).toBe('claude-missing');
  });

  it('a real sandbox failure stays a sandbox failure, with no Claude repair on offer', async () => {
    vi.mocked(memorySandboxWorks).mockResolvedValue(false);
    const w = wire(binary('ok', '2.1.318'), [binary('new', '2.1.318')]);
    await w.ready;
    expect(captured.blocker?.()).toBe('sandbox');
    const token = tokenIn(w.recovery.ownerMessage());
    expect(token).toHaveLength(43);
    expect(w.recovery.canRepair(token)).toBe(false);
  });

  it('never offers a candidate below the floor', async () => {
    const w = wire(binary('old', '2.1.300'), [binary('alsoold', '2.1.315')]);
    await w.ready;
    expect(w.recovery.canRepair(tokenIn(w.recovery.ownerMessage()))).toBe(false);
  });

  it('the link repairs: config, live sessions and readiness all move, and other config stays', async () => {
    const good = binary('new', '2.1.318');
    const w = wire(binary('old', '2.1.300'), [good]);
    await w.ready;
    expect(await w.recovery.redeem(tokenIn(w.recovery.ownerMessage()))).toBe('fixed');
    expect(config().sessions).toEqual({ claudePath: good, maxSessions: 3 });
    expect(config().memoryPrivacy).toBeUndefined();
    expect(setClaudeBinary).toHaveBeenCalledWith(good);
    expect(captured.sandboxReady()).toBe(true);
    expect(captured.blocker?.()).toBeNull();
  });

  it('a config that will not parse leaves the server up and the agent still refusing', async () => {
    const w = wire(binary('old', '2.1.300'), [binary('new', '2.1.318')]);
    await w.ready;
    const message = w.recovery.ownerMessage();
    fs.writeFileSync(path.join(dir, '.instar', 'config.json'), '{ not json');
    expect(await w.recovery.redeem(tokenIn(message))).toBe('not-fixed');
    expect(setClaudeBinary).not.toHaveBeenCalled();
    expect(captured.sandboxReady()).toBe(false);
  });

  it('with no address for the link, the owner gets the manual step and no localhost link', async () => {
    const w = wireMemoryPrivacy({
      projectDir: dir, stateDir: path.join(dir, '.instar'), projectName: 'indra', instarRoot: dir,
      framework: () => 'claude-code', memoryPrivacy: () => ({ enabled: true, ownerUserId: 'justin' }), messaging: () => [],
      claudePath: binary('old', '2.1.300'), claudeCandidates: [binary('new', '2.1.318')],
      sessionManager: { setMemoryPrivacy: () => {}, setClaudeBinary } as unknown as SessionManager,
    });
    await w.ready;
    const text = w.recovery.ownerMessage();
    expect(text).toContain('sessions.claudePath');
    expect(text).not.toContain('localhost');
  });

  it('measures the candidate again at repair time, and changes nothing if it went bad', async () => {
    const good = binary('new', '2.1.318');
    const w = wire(binary('old', '2.1.300'), [good]);
    await w.ready;
    const message = w.recovery.ownerMessage();
    fs.writeFileSync(good, '#!/bin/sh\necho "2.1.1 (Claude Code)"\n', { mode: 0o755 });
    expect(await w.recovery.redeem(tokenIn(message))).toBe('not-fixed');
    expect(config().sessions.claudePath).toBe('/old');
    expect(setClaudeBinary).not.toHaveBeenCalled();
    expect(w.recovery.canRepair(tokenIn(w.recovery.ownerMessage()))).toBe(false);
  });
});
