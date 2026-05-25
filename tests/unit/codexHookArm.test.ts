import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installCodexHooks, buildInstarCodexHookGroups } from '../../src/core/installCodexHooks.js';
import { armCodexHooks, projectHooksAreInstarOwned } from '../../src/core/codexHookArm.js';
import { expectedHookSlots } from '../../src/core/codexHookTrust.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let projectDir: string;
let codexHome: string;
let hooksJsonPath: string;
let slots: string[];

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-proj-'));
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-home-'));
  installCodexHooks(projectDir); // writes an instar-owned .codex/hooks.json
  // Codex (and armCodexHooks' readback) key trust by the CANONICAL path — realpath it
  // so writeTrust() entries match what the readback looks for (matches production).
  hooksJsonPath = path.join(fs.realpathSync(projectDir), '.codex', 'hooks.json');
  slots = expectedHookSlots(buildInstarCodexHookGroups(projectDir) as any);
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/codexHookArm.test.ts:afterEach' });
  SafeFsExecutor.safeRmSync(codexHome, { recursive: true, force: true, operation: 'tests/unit/codexHookArm.test.ts:afterEach' });
});

function writeTrust(trustedSlots: string[], disabledSlots: string[] = []): void {
  let body = 'model = "gpt-5.5"\n\n';
  for (const slot of trustedSlots) {
    body += `[hooks.state."${hooksJsonPath}:${slot}"]\ntrusted_hash = "sha256:fake-${slot}"\n`;
    if (disabledSlots.includes(slot)) body += 'enabled = false\n';
    body += '\n';
  }
  fs.writeFileSync(path.join(codexHome, 'config.toml'), body);
}

describe('projectHooksAreInstarOwned', () => {
  it('is true for an installCodexHooks-written project', () => {
    expect(projectHooksAreInstarOwned(projectDir)).toBe(true);
  });
  it('is false when hooks.json is missing or not instar-owned', () => {
    fs.writeFileSync(hooksJsonPath, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'node /tmp/evil.js' }] }] } }));
    expect(projectHooksAreInstarOwned(projectDir)).toBe(false);
  });
});

describe('armCodexHooks', () => {
  it('returns already-armed and does NOT spawn when every slot is trusted (idempotent, F2)', () => {
    writeTrust(slots);
    const driver = () => { throw new Error('driver must not run when already armed'); };
    expect(armCodexHooks({ projectDir, codexHome, trustDriver: driver })).toEqual({ status: 'already-armed' });
  });

  it('skips (refuses to trust) when hooks.json is not instar-owned (F1 manifest verify)', () => {
    fs.writeFileSync(hooksJsonPath, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'node /tmp/evil.js' }] }] } }));
    let ran = false;
    const out = armCodexHooks({ projectDir, codexHome, trustDriver: () => { ran = true; } });
    expect(out.status).toBe('skipped');
    expect(ran).toBe(false); // never drove trust on an unverified manifest
  });

  it('arms: drives trust then reads back all slots trusted', () => {
    // start unarmed (no config); driver simulates the trust write for all slots
    const driver = () => writeTrust(slots);
    expect(armCodexHooks({ projectDir, codexHome, trustDriver: driver })).toEqual({ status: 'armed' });
  });

  it('reports partial when the readback shows some slots still untrusted (F2 readback)', () => {
    const driver = () => writeTrust(slots.slice(0, 2)); // only trust the first two
    const out = armCodexHooks({ projectDir, codexHome, trustDriver: driver });
    expect(out.status).toBe('partial');
    if (out.status === 'partial') expect(out.untrusted.length).toBeGreaterThan(0);
  });

  it('surfaces (does not silently re-enable) a user-disabled slot (F3)', () => {
    const driver = () => writeTrust(slots, [slots[0]]); // slot[0] trusted but enabled=false
    const out = armCodexHooks({ projectDir, codexHome, trustDriver: driver });
    expect(out.status).toBe('partial');
    if (out.status === 'partial') expect(out.disabled).toContain(slots[0]);
  });
});
