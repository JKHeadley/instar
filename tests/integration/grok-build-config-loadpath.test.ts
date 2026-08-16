/**
 * Integration — grok-build interactive dual gate THROUGH the config FILE
 * load path (grok-build spec §4.3/§12 round-9).
 *
 * The file-load tier exists BY NAME: the three prior load-path-gap
 * incidents (componentFrameworks 2026-06-06, frameworkDefaultModels
 * 2026-06-25, dynamicMcp 2026-06-27) all shipped because their tests built
 * config objects in-memory, bypassing loadConfig — and the grok interactive
 * gate became the FOURTH instance in spec review. This test writes a REAL
 * `.instar/config.json` and asserts the sessions slice SessionManager
 * receives actually carries both levers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/core/Config.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('grok-build config file load path (the fourth load-path-gap lift)', () => {
  let dir: string;
  /**
   * A REAL file standing in for a framework CLI.
   *
   * WHY: `loadConfig` runs the framework-prerequisite check, which refuses boot
   * when the configured framework's binary cannot be found. This suite is about
   * config LOAD-PATH semantics, not about what happens to be installed on the
   * host — and it was green on a dev box with claude + grok present and RED on
   * CI, which has neither. Three shards, one cause. A test whose verdict depends
   * on the machine it runs on is not testing what its name says.
   *
   * It must be a real file on disk, not a plausible-looking string:
   * `mergeOperatorBinaryPaths` drops a configured path it can POSITIVELY show is
   * absent, which is exactly the guard that stops a stale entry faking a
   * prerequisite. The stub satisfies it honestly instead of dodging it.
   */
  let stubBinary: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-loadpath-'));
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    stubBinary = path.join(dir, 'stub-framework-cli');
    fs.writeFileSync(stubBinary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  });
  afterEach(() => {
    try {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/integration/grok-build-config-loadpath.test.ts:cleanup',
      });
    } catch { /* best-effort */ }
  });

  function writeConfig(cfg: Record<string, unknown>): void {
    const caseSessions = (cfg.sessions ?? {}) as Record<string, unknown>;
    const casePaths = (caseSessions.frameworkBinaryPaths ?? {}) as Record<string, string>;
    const sessions = {
      ...caseSessions,
      // Per-KEY merge, not object replacement: a case that pins one framework's
      // path (the operator-wins assertion) keeps its own value AND keeps the
      // others satisfied, so pinning one binary cannot accidentally un-boot the
      // agent for another.
      // ONLY claude-code by default. A grok entry here would be indistinguishable
      // from an operator-set one, which would silently defeat the control that
      // asserts an ABSENT operator value never erases a DETECTED grok path — the
      // test would still pass while measuring nothing. Cases that resolve to
      // grok-build supply their own grok path explicitly.
      frameworkBinaryPaths: {
        'claude-code': stubBinary,
        ...casePaths,
      },
    };
    fs.writeFileSync(
      path.join(dir, '.instar', 'config.json'),
      JSON.stringify({ projectName: 'loadpath-test', authToken: 't', ...cfg, sessions }),
    );
  }

  it('BOTH levers set in the FILE ⇒ both present on the sessions slice', () => {
    writeConfig({
      enabledFrameworks: ['claude-code', 'grok-build'],
      sessions: { grokInteractiveSessions: true },
    });
    const config = loadConfig(dir);
    expect(config.sessions.enabledFrameworks).toContain('grok-build');
    expect(config.sessions.grokInteractiveSessions).toBe(true);
  });

  it('opt-in absent in the FILE ⇒ slice carries no grokInteractiveSessions (gate stays closed)', () => {
    writeConfig({ enabledFrameworks: ['claude-code', 'grok-build'] });
    const config = loadConfig(dir);
    expect(config.sessions.grokInteractiveSessions).toBeUndefined();
  });

  it('enabledFrameworks absent ⇒ slice enabledFrameworks is absent (dark default)', () => {
    writeConfig({ sessions: { grokInteractiveSessions: true } });
    const config = loadConfig(dir);
    expect(config.sessions.enabledFrameworks ?? []).not.toContain('grok-build');
  });

  // ── round-11 (adversarial): the SEVENTH load-path-gap instance ──
  // §2.1 named `frameworkBinaryPaths['grok-build']` as rung 2 of the normative
  // binary order, but the map was built PURELY from detection — so the operator
  // value was silently discarded and the "lever" had no load path at all.

  // ── round-22: this test asserted the operator value wins using the path
  // `/opt/operator/grok`, which exists on no machine. That was correct until
  // round-21 added an existence guard (mergeOperatorBinaryPaths drops a path it
  // can POSITIVELY show is absent, so a stale entry cannot silently decide which
  // binary gets spawned). The guard was reasoned from a real risk and shipped
  // without re-running the test that covered the behaviour it changed — the same
  // never-re-measured shape as the round-19/20 findings, caught by the suite.
  //
  // Both properties are real and BOTH are now covered: an operator path that
  // exists wins over detection, and one that provably does not is dropped loudly.

  it('an operator-set frameworkBinaryPath REACHES the sessions slice and WINS over detection', () => {
    // A real file, so the round-21 existence guard admits it. Using a
    // non-existent path here would silently exercise the DROP branch and this
    // test would pass for the wrong reason on any host with no grok installed.
    const operatorBinary = path.join(dir, 'operator-grok');
    fs.writeFileSync(operatorBinary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeConfig({
      enabledFrameworks: ['claude-code', 'grok-build'],
      sessions: { frameworkBinaryPaths: { 'grok-build': operatorBinary } },
    });
    const config = loadConfig(dir);
    expect(config.sessions.frameworkBinaryPaths?.['grok-build']).toBe(operatorBinary);
  });

  it('a provably-absent operator path is DROPPED, not spawned (round-21 guard)', () => {
    writeConfig({
      enabledFrameworks: ['claude-code', 'grok-build'],
      sessions: { frameworkBinaryPaths: { 'grok-build': '/opt/operator/definitely-not-here/grok' } },
    });
    const config = loadConfig(dir);
    expect(config.sessions.frameworkBinaryPaths?.['grok-build']).not.toBe(
      '/opt/operator/definitely-not-here/grok',
    );
  });

  it('CONTROL: with no operator value, detection still fills the map (the lever is additive)', () => {
    writeConfig({ enabledFrameworks: ['claude-code', 'grok-build'] });
    const config = loadConfig(dir);
    // Either detection found a binary on this host or it did not; what must NOT
    // happen is the operator's absent value erasing a detected one.
    const detected = config.sessions.frameworkBinaryPaths?.['grok-build'];
    expect(detected === undefined || detected.endsWith('/grok')).toBe(true);
  });

  it('resolves the RUNTIME framework to grok-build from enabledFrameworks alone', () => {
    // The Groky shape: a config that says "run on grok" and nothing else.
    // INSTAR_FRAMEWORK outranks enabledFrameworks BY DESIGN (arm 2 before arm
    // 3), and the dev shell exports it — so clear it, or this asserts the
    // developer's environment rather than the load path.
    const prevEnv = process.env['INSTAR_FRAMEWORK'];
    delete process.env['INSTAR_FRAMEWORK'];
    try {
      // This case RESOLVES to grok-build, so it must supply grok's binary path
      // itself — the shared default deliberately covers claude-code only. Without
      // it the case passes on a dev box with grok installed and fails on any host
      // without it, which is the exact split that made three CI shards red while
      // the suite was green locally.
      writeConfig({
        enabledFrameworks: ['grok-build'],
        sessions: { frameworkBinaryPaths: { 'grok-build': stubBinary } },
      });
      const config = loadConfig(dir);
      expect(config.sessions.framework).toBe('grok-build');
    } finally {
      if (prevEnv === undefined) delete process.env['INSTAR_FRAMEWORK'];
      else process.env['INSTAR_FRAMEWORK'] = prevEnv;
    }
  });

  it('CONTROL: INSTAR_FRAMEWORK still outranks enabledFrameworks (precedence unchanged)', () => {
    const prevEnv = process.env['INSTAR_FRAMEWORK'];
    process.env['INSTAR_FRAMEWORK'] = 'claude-code';
    try {
      writeConfig({ enabledFrameworks: ['grok-build'] });
      expect(loadConfig(dir).sessions.framework).toBe('claude-code');
    } finally {
      if (prevEnv === undefined) delete process.env['INSTAR_FRAMEWORK'];
      else process.env['INSTAR_FRAMEWORK'] = prevEnv;
    }
  });
});
