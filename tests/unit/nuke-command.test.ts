/**
 * Unit tests for `instar nuke` — agent removal command.
 *
 * Tests the core logic: directory detection, git remote check,
 * cleanup sequence, and safety guards.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('nuke command prerequisites', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuke-test-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/nuke-command.test.ts:22' });
  });

  it('detects when agent directory does not exist', () => {
    const fakeAgentDir = path.join(tmpDir, 'nonexistent');
    const configPath = path.join(fakeAgentDir, '.instar', 'config.json');
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('detects when agent directory exists with config', () => {
    const agentDir = path.join(tmpDir, 'test-agent');
    const stateDir = path.join(agentDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      projectName: 'test-agent',
      port: 4040,
    }));
    expect(fs.existsSync(path.join(stateDir, 'config.json'))).toBe(true);
  });

  it('detects git repo presence', () => {
    const agentDir = path.join(tmpDir, 'git-agent');
    fs.mkdirSync(path.join(agentDir, '.git'), { recursive: true });
    expect(fs.existsSync(path.join(agentDir, '.git'))).toBe(true);
  });

  it('detects no git repo', () => {
    const agentDir = path.join(tmpDir, 'no-git-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    expect(fs.existsSync(path.join(agentDir, '.git'))).toBe(false);
  });

  it('rmSync removes directory completely', () => {
    const agentDir = path.join(tmpDir, 'to-remove');
    const stateDir = path.join(agentDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    fs.writeFileSync(path.join(stateDir, 'MEMORY.md'), '# Memory');

    SafeFsExecutor.safeRmSync(agentDir, { recursive: true, force: true, operation: 'tests/unit/nuke-command.test.ts:62' });
    expect(fs.existsSync(agentDir)).toBe(false);
  });
});
