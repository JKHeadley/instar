// safe-git-allow: test file — fs.rmSync is for per-test tmpdir cleanup only.

/**
 * Layer 2 (scaffold seed) tests for the agent worktree convention.
 *
 * Spec: docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md §"Layer 2 — Scaffold
 * seed (new agents)".
 *
 * These pin the literal text and structural invariants that new agents
 * receive on `instar init`. The point is to keep the seed honest — an
 * agent that doesn't know about the convention effectively doesn't have
 * it (Agent Awareness Standard, CLAUDE.md).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateClaudeMd,
  generateMemoryMd,
} from '../../src/scaffold/templates.js';
import { ensureGitignore } from '../../src/core/MachineIdentity.js';

describe('scaffold seed: Worktree Convention section', () => {
  it('generateClaudeMd contains a "Worktree Convention" section that names the CLI command', () => {
    const md = generateClaudeMd('test-project', 'test-agent', 4040, false);
    expect(md).toMatch(/##\s+Worktree Convention/);
    // Literal phrase from the spec — avoids deictic "my home / this agent"
    // ambiguity flagged in Round 1 review.
    expect(md).toContain('instar worktree create <branch>');
    expect(md).toContain('Never hardcode another agent');
  });

  it('generateClaudeMd Worktree Convention section warns about GIT_AUTHOR_NAME env override', () => {
    const md = generateClaudeMd('test-project', 'test-agent', 4040, false);
    expect(md).toMatch(/GIT_AUTHOR_NAME/);
    expect(md).toMatch(/GIT_COMMITTER_EMAIL/);
  });

  it('generateMemoryMd seeds a worktree-convention entry under Project Patterns', () => {
    const md = generateMemoryMd('test-agent');
    expect(md).toMatch(/Worktree convention/);
    expect(md).toContain('instar worktree create <branch>');
    // Mentions the *why* so it survives memory-hygiene passes.
    expect(md).toMatch(/sandbox/i);
  });
});

describe('scaffold seed: .gitignore includes .worktrees/', () => {
  it('ensureGitignore appends .worktrees/ entry to a fresh .gitignore', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iwm-gitignore-'));
    try {
      ensureGitignore(tmp);
      const content = fs.readFileSync(path.join(tmp, '.gitignore'), 'utf-8');
      expect(content).toMatch(/^\.worktrees\/$/m);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('ensureGitignore is idempotent — second run does not duplicate', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iwm-gitignore-idem-'));
    try {
      ensureGitignore(tmp);
      ensureGitignore(tmp);
      const content = fs.readFileSync(path.join(tmp, '.gitignore'), 'utf-8');
      const matches = content.match(/^\.worktrees\/$/gm) ?? [];
      expect(matches.length).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
