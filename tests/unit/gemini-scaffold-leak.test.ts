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

describe('isKnownFramework — the canonical guard that closed the drift', () => {
  it('accepts every IntelligenceFramework and nothing else', () => {
    expect(KNOWN_FRAMEWORKS).toEqual(['claude-code', 'codex-cli', 'gemini-cli']);
    for (const f of KNOWN_FRAMEWORKS) expect(isKnownFramework(f)).toBe(true);
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
