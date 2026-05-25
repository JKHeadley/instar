/**
 * Tests for the Codex hook-contract canary.
 *
 * Layer A (deterministic invariant lock) must always assert the load-bearing
 * shape regardless of host. Layer B (live-binary probe) is best-effort — on a
 * host with a real codex it returns 'pass'; without one it returns 'skip'
 * (NEVER 'fail' for a missing binary).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runCodexHookContractCanary,
  resolveCodexBinaryForCanary,
  REQUIRED_CODEX_HOOK_EVENTS,
  checkInstalledCodexHookTrust,
} from '../../../../../../src/providers/adapters/openai-codex/canary/codexHookContractCanary.js';
import { installCodexHooks, buildInstarCodexHookGroups } from '../../../../../../src/core/installCodexHooks.js';
import { expectedHookSlots } from '../../../../../../src/core/codexHookTrust.js';
import { SafeFsExecutor } from '../../../../../../src/core/SafeFsExecutor.js';

describe('runCodexHookContractCanary', () => {
  it('locks the load-bearing invariants: regex matcher, shell guard, deferral on PreToolUse, correct Stop trio', () => {
    const result = runCodexHookContractCanary();
    // Layer A must never fail on a correctly-wired tree.
    expect(result.details.matcherIsRegex, '.* matcher').toBe(true);
    expect(result.details.dangerousGuardOnPreToolUse, 'dangerous-command-guard on PreToolUse').toBe(true);
    expect(result.details.deferralOnPreToolUse, 'deferral-detector on PreToolUse (not Stop)').toBe(true);
    expect(result.details.stopReviewTrioWired, 'response-review + claim-intercept-response + scope-coherence on Stop').toBe(true);
    expect(result.details.failures).toEqual([]);
  });

  it('never reports the layer-A invariants as a FAIL when wiring is correct', () => {
    const result = runCodexHookContractCanary();
    // Status is 'pass' (binary present + declares events) or 'skip' (no binary),
    // but layer-A correctness means it must not be 'fail'.
    expect(result.status).not.toBe('fail');
  });

  it('skips (not fails) the binary layer when no codex binary declares the schema', () => {
    const result = runCodexHookContractCanary();
    if (!result.details.binaryProbed) {
      expect(result.status).toBe('skip');
      expect(result.details.missingEventsInBinary).toEqual([]);
    }
  });

  it('when a codex binary IS probed, it declares every required hook event', () => {
    const result = runCodexHookContractCanary();
    if (result.details.binaryProbed) {
      // A real, hooks-capable codex must still carry our depended-on events.
      expect(result.details.missingEventsInBinary).toEqual([]);
      expect(result.status).toBe('pass');
    } else {
      // No representative binary on this host — nothing to assert here.
      expect(result.details.binaryProbed).toBe(false);
    }
  });

  it('exposes the required-events contract list', () => {
    expect(REQUIRED_CODEX_HOOK_EVENTS).toContain('PreToolUse');
    expect(REQUIRED_CODEX_HOOK_EVENTS).toContain('Stop');
    expect(REQUIRED_CODEX_HOOK_EVENTS).toContain('SessionStart');
  });

  it('resolveCodexBinaryForCanary returns a string path or null (never throws)', () => {
    const p = resolveCodexBinaryForCanary();
    expect(p === null || typeof p === 'string').toBe(true);
  });
});

describe('checkInstalledCodexHookTrust (Layer C — live-config drift)', () => {
  let projectDir: string;
  let codexHome: string;
  let hooksJsonPath: string;
  let slots: string[];

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canaryC-proj-'));
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'canaryC-home-'));
    installCodexHooks(projectDir);
    hooksJsonPath = path.join(fs.realpathSync(projectDir), '.codex', 'hooks.json');
    slots = expectedHookSlots(buildInstarCodexHookGroups(projectDir) as any);
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'canaryC:proj' });
    SafeFsExecutor.safeRmSync(codexHome, { recursive: true, force: true, operation: 'canaryC:home' });
  });

  function writeTrust(trustedSlots: string[], disabled: string[] = []): void {
    let body = '';
    for (const s of trustedSlots) {
      body += `[hooks.state."${hooksJsonPath}:${s}"]\ntrusted_hash = "sha256:x-${s}"\n`;
      if (disabled.includes(s)) body += 'enabled = false\n';
      body += '\n';
    }
    fs.writeFileSync(path.join(codexHome, 'config.toml'), body);
  }

  it('skips when the project has no .codex/hooks.json', () => {
    const r = checkInstalledCodexHookTrust(fs.mkdtempSync(path.join(os.tmpdir(), 'empty-')), codexHome);
    expect(r.status).toBe('skip');
    expect(r.hooksJsonPresent).toBe(false);
  });

  it("reports 'drift' when the installed trio is present but UNtrusted (dark agent)", () => {
    // hooks.json installed (correct trio) but config.toml has no trust entries
    const r = checkInstalledCodexHookTrust(projectDir, codexHome);
    expect(r.stopTrioInstalled).toBe(true);
    expect(r.status).toBe('drift');
    expect(r.allArmed).toBe(false);
    expect(r.untrusted.length).toBeGreaterThan(0);
  });

  it("reports 'ok' when the trio is installed AND all slots are trusted", () => {
    writeTrust(slots);
    const r = checkInstalledCodexHookTrust(projectDir, codexHome);
    expect(r.status).toBe('ok');
    expect(r.stopTrioInstalled).toBe(true);
    expect(r.allArmed).toBe(true);
  });

  it("reports 'drift' when a slot is explicitly disabled (enabled=false)", () => {
    writeTrust(slots, [slots[0]]);
    const r = checkInstalledCodexHookTrust(projectDir, codexHome);
    expect(r.status).toBe('drift');
    expect(r.disabled).toContain(slots[0]);
  });

  it("detects a clobbered hooks.json where deferral-detector wrongly sits on Stop", () => {
    // Simulate the historical bug: rewrite Stop with deferral-detector instead of claim-intercept-response
    const cfg = JSON.parse(fs.readFileSync(path.join(projectDir, '.codex', 'hooks.json'), 'utf-8'));
    cfg.hooks.Stop[0].hooks = [
      { type: 'command', command: `node ${projectDir}/.instar/hooks/instar/response-review.js` },
      { type: 'command', command: `node ${projectDir}/.instar/hooks/instar/deferral-detector.js` },
      { type: 'command', command: `node ${projectDir}/.instar/hooks/instar/scope-coherence-checkpoint.js` },
    ];
    fs.writeFileSync(path.join(projectDir, '.codex', 'hooks.json'), JSON.stringify(cfg));
    writeTrust(expectedHookSlots(cfg.hooks));
    const r = checkInstalledCodexHookTrust(projectDir, codexHome);
    expect(r.status).toBe('drift');
    expect(r.stopTrioInstalled).toBe(false); // claim-intercept-response missing
    expect(r.issues.join(' ')).toMatch(/deferral-detector\.js is on Stop|Stop trio incomplete/);
  });
});
