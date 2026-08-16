/**
 * Unit test — gemini-cli scaffold leak (framework-issue fa93e951).
 *
 * Bug: refreshHooksAndSettings() read `enabledFrameworks` from config.json
 * through a hardcoded filter `f === 'claude-code' || f === 'codex-cli'` that
 * silently DROPPED 'gemini-cli'. A gemini-only config produced an empty filtered
 * list and fell through to the `['claude-code']` default, so `claudeEnabled`
 * became true and installClaudeSettings() wrote a full Claude .claude/settings.json
 * into a gemini-only agent. Fixed by filtering through the complete
 * `isKnownFramework` guard.
 *
 * Found via live dogfooding: Codey installed a gemini agent and reported it still
 * had a 7.5KB .claude/settings.json despite enabledFrameworks=['gemini-cli'].
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refreshHooksAndSettings, isKnownFramework, KNOWN_FRAMEWORKS } from '../../src/commands/init.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmp: string;
let projectDir: string;
let stateDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-scaffold-leak-'));
  projectDir = tmp;
  stateDir = path.join(tmp, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, sourceTreeOverride: true });
});

function writeConfig(enabledFrameworks: string[]): void {
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 4042, enabledFrameworks }));
}

const claudeSettingsPath = () => path.join(projectDir, '.claude', 'settings.json');

/**
 * The union members, parsed from the ONE place the type is declared.
 *
 * Round-21 note (why this is parsed and not written out): this expectation used
 * to be the literal list `['claude-code', 'codex-cli', 'gemini-cli']`. When the
 * union grew to five, the guard under test correctly grew with it and THIS TEST
 * went red — a hand-maintained list inside the test whose stated job is to stop
 * hand-maintained lists drifting. Deriving from the declaration is the only
 * version that cannot rot: adding a sixth framework to the union with no matching
 * runtime entry now fails here instead of silently narrowing the filter (which is
 * how a grok-only agent got Claude scaffolding installed on every update).
 *
 * This is deliberately NOT compared against SUPPORTED_FRAMEWORKS: init.ts assigns
 * KNOWN_FRAMEWORKS = SUPPORTED_FRAMEWORKS, so that comparison is a tautology and
 * would pass with both lists equally stale. The type declaration is an
 * independent source, so the comparison can genuinely fail.
 */
const UNION_MEMBERS: string[] = (() => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/core/intelligenceProviderFactory.ts'),
    'utf-8',
  );
  const decl = src.match(/export type IntelligenceFramework\s*=\s*([^;]+);/);
  if (!decl) throw new Error('IntelligenceFramework union not found — the declaration moved; update this parser.');
  const members = [...decl[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (members.length < 3) throw new Error(`parsed only ${members.length} union members — parser is broken, not the code`);
  return members;
})();

describe('isKnownFramework — the canonical guard that closed the drift', () => {
  it('accepts every IntelligenceFramework and nothing else', () => {
    // Order-insensitive: the guard is a membership test, not a sequence.
    expect([...KNOWN_FRAMEWORKS].sort()).toEqual([...UNION_MEMBERS].sort());
    for (const f of KNOWN_FRAMEWORKS) expect(isKnownFramework(f)).toBe(true);
    for (const f of UNION_MEMBERS) expect(isKnownFramework(f)).toBe(true);
    expect(isKnownFramework('gemini-cli')).toBe(true); // the one that was dropped
    expect(isKnownFramework('not-a-framework')).toBe(false);
    expect(isKnownFramework(undefined)).toBe(false);
    expect(isKnownFramework(123)).toBe(false);
  });
});

describe('refreshHooksAndSettings — no Claude scaffold leak into non-claude agents', () => {
  it('does NOT write .claude/settings.json for a gemini-only install', () => {
    writeConfig(['gemini-cli']);
    refreshHooksAndSettings(projectDir, stateDir);
    expect(fs.existsSync(claudeSettingsPath())).toBe(false);
  });

  it('does NOT write .claude/settings.json for a codex-only install', () => {
    writeConfig(['codex-cli']);
    refreshHooksAndSettings(projectDir, stateDir);
    expect(fs.existsSync(claudeSettingsPath())).toBe(false);
  });

  /**
   * ROUND-22 — the two cases this file did NOT cover were the two the round-21
   * defect actually hit.
   *
   * The header describes grok-only agents receiving Claude scaffolding on every
   * update. The cases below it were gemini-only and codex-only: the frameworks
   * that were NEVER affected, because the stale `KNOWN_FRAMEWORKS` listed exactly
   * those three. So the file demonstrated the fix on the inputs that passed
   * before the fix, and said nothing about the inputs that failed.
   *
   * These two are proper controls: against the pre-fix three-name list, `grok-build`
   * and `pi-cli` are filtered out, the empty result falls back to `['claude-code']`,
   * `claudeEnabled` becomes true, and both assertions below fail.
   */
  it('does NOT write .claude/settings.json for a grok-only install (the reported defect)', () => {
    writeConfig(['grok-build']);
    refreshHooksAndSettings(projectDir, stateDir);
    expect(fs.existsSync(claudeSettingsPath())).toBe(false);
  });

  it('does NOT write .claude/settings.json for a pi-only install (the silent neighbour)', () => {
    writeConfig(['pi-cli']);
    refreshHooksAndSettings(projectDir, stateDir);
    expect(fs.existsSync(claudeSettingsPath())).toBe(false);
  });

  it('STILL writes .claude/settings.json for a claude-code install (no regression)', () => {
    writeConfig(['claude-code']);
    refreshHooksAndSettings(projectDir, stateDir);
    expect(fs.existsSync(claudeSettingsPath())).toBe(true);
  });

  it('writes .claude/settings.json when claude-code is among multiple frameworks', () => {
    writeConfig(['claude-code', 'gemini-cli']);
    refreshHooksAndSettings(projectDir, stateDir);
    expect(fs.existsSync(claudeSettingsPath())).toBe(true);
  });
});
