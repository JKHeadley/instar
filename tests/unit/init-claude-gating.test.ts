/**
 * Verifies the Claude-Code-only scaffolding is properly gated on the
 * `--framework` flag (PR 2 of 4 of the install/wizard portability series).
 *
 * Success criterion: a Codex-only standalone init produces zero `.claude/`
 * directory entries (no settings.json, no scripts/, no skills/) and no
 * CLAUDE.md, while still producing the canonical AGENT.md and the
 * AGENTS.md shadow. A default (no flag) install is byte-identical to
 * historical behavior — CLAUDE.md + .claude/settings.json present.
 *
 * Uses the standalone init path because it's the cleanest target for an
 * isolated-filesystem test (no git, no port allocation conflicts, no
 * external prerequisites).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initProject } from '../../src/commands/init.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('init Claude-Code gating (PR 2 — codex-only zero-.claude/ guarantee)', () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-init-gate-'));
    prevHome = process.env.HOME;
    // Redirect standalone agent home so the test doesn't touch ~/.instar.
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    SafeFsExecutor.safeRmSync(tmpHome, {
      recursive: true,
      force: true,
      operation: 'tests/unit/init-claude-gating.test.ts',
    });
  });

  it('codex-only standalone init produces ZERO .claude/ entries and NO CLAUDE.md', async () => {
    const agentName = 'codex-only-test-' + Math.random().toString(36).slice(2, 8);
    await initProject({
      name: agentName,
      standalone: true,
      port: 4099,
      framework: 'codex-cli',
      skipPrereqs: true,
    });

    const agentDir = path.join(tmpHome, '.instar', 'agents', agentName);
    expect(fs.existsSync(agentDir)).toBe(true);

    // Hard requirement: no .claude/ directory at all.
    expect(fs.existsSync(path.join(agentDir, '.claude'))).toBe(false);

    // Hard requirement: no CLAUDE.md (the rich capability doc is Claude-only).
    expect(fs.existsSync(path.join(agentDir, 'CLAUDE.md'))).toBe(false);

    // Canonical identity present.
    expect(fs.existsSync(path.join(agentDir, '.instar', 'AGENT.md'))).toBe(true);

    // AGENTS.md shadow rendered from canonical (this is what Codex auto-loads).
    expect(fs.existsSync(path.join(agentDir, 'AGENTS.md'))).toBe(true);

    // Persisted choice readable by downstream consumers (migrator, sentinel).
    const cfg = JSON.parse(fs.readFileSync(path.join(agentDir, '.instar', 'config.json'), 'utf-8'));
    expect(cfg.enabledFrameworks).toEqual(['codex-cli']);
  });

  it('default (no --framework) standalone init keeps historical behavior: CLAUDE.md + .claude/', async () => {
    const agentName = 'default-test-' + Math.random().toString(36).slice(2, 8);
    await initProject({
      name: agentName,
      standalone: true,
      port: 4098,
      skipPrereqs: true,
      // no `framework` field
    });

    const agentDir = path.join(tmpHome, '.instar', 'agents', agentName);
    expect(fs.existsSync(path.join(agentDir, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, '.claude'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, '.claude', 'settings.json'))).toBe(true);

    const cfg = JSON.parse(fs.readFileSync(path.join(agentDir, '.instar', 'config.json'), 'utf-8'));
    expect(cfg.enabledFrameworks).toEqual(['claude-code']);
  });

  it('framework=both standalone init produces BOTH CLAUDE.md and AGENTS.md and .claude/', async () => {
    const agentName = 'both-test-' + Math.random().toString(36).slice(2, 8);
    await initProject({
      name: agentName,
      standalone: true,
      port: 4097,
      framework: 'both',
      skipPrereqs: true,
    });

    const agentDir = path.join(tmpHome, '.instar', 'agents', agentName);
    expect(fs.existsSync(path.join(agentDir, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, '.claude', 'settings.json'))).toBe(true);

    const cfg = JSON.parse(fs.readFileSync(path.join(agentDir, '.instar', 'config.json'), 'utf-8'));
    expect(cfg.enabledFrameworks).toEqual(['claude-code', 'codex-cli']);
  });
});
