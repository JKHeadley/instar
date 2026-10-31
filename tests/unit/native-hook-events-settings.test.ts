/**
 * Native hook events — settings generation, reconcile, migration and the
 * version/loopback gate (docs/specs/native-hook-events.md D1, D4).
 *
 * Acceptance criteria covered: 1 (flag off ⇒ settings identical to today),
 * 3c (migrateSettings twice with the flag on changes nothing; the existing
 * http-hook migrations leave the native entry alone), 6 (flag on ⇒ the 7
 * entries rewritten; flag off ⇒ command entries restored; custom hooks
 * untouched; Claude Code < 2.1.310 ⇒ command entries + one degradation),
 * 6a (a settings file overwritten between boot and spawn is rewritten before
 * the session starts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildHttpHookSettings,
  NATIVE_REPORTER_EVENTS,
  NATIVE_HOOK_EVENTS_PATH,
  REPORTER_COMMAND_HOOK,
  buildNativeReporterHook,
  reconcileReporterHooks,
  isNativeReporterHook,
} from '../../src/data/http-hook-templates.js';
import {
  decideNativeReporter,
  decideNativeReporterFromConfig,
  resolveSessionClaudeVersion,
  nativeHookBaseUrl,
  bootReconcileNativeReporter,
  compareClaudeVersions,
  effectiveListenHost,
} from '../../src/core/nativeHookEventsGate.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

type Hooks = Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;

/** A fake Claude Code npm install at a given version. */
function fakeClaude(root: string, version: string): string {
  const dir = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version }));
  const bin = path.join(dir, 'bin', 'claude');
  fs.writeFileSync(bin, '\x7fELF-not-really');
  return bin;
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'native-hooks-settings-'));
}

/** Today's settings: the reporter template plus a custom hook and an unrelated instar hook. */
function todaysSettings(): Record<string, unknown> {
  const hooks = buildHttpHookSettings('http://localhost:4040') as Hooks;
  hooks.PostToolUse.push({ matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/working-set-artifact-recorder.js"', timeout: 5000 }] });
  hooks.Stop.push({ matcher: '', hooks: [{ type: 'command', command: 'node my-custom-stop.js', timeout: 3 }] });
  hooks.PostToolUse.push({ matcher: 'Bash', hooks: [{ type: 'http', url: 'http://example.test/custom' }] });
  return { hooks };
}

describe('native reporter hook shape', () => {
  it('is an http hook to the native path with 1 s timeout, the four headers and allowedEnvVars, never onFailure:block', () => {
    const h = buildNativeReporterHook('http://127.0.0.1:4040');
    expect(h).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:4040/hooks/native-events',
      timeout: 1,
      headers: {
        Authorization: 'Bearer ${INSTAR_AUTH_TOKEN}',
        'X-Instar-Session-Id': '${INSTAR_SESSION_ID}',
        'X-Instar-Session': '${INSTAR_SESSION_NAME}',
        'X-Instar-AgentId': '${INSTAR_AGENT_ID}',
      },
      allowedEnvVars: ['INSTAR_AUTH_TOKEN', 'INSTAR_SESSION_ID', 'INSTAR_SESSION_NAME', 'INSTAR_AGENT_ID'],
    });
    expect(h).not.toHaveProperty('onFailure');
    // The path deliberately avoids the substring the old migrations match.
    expect(NATIVE_HOOK_EVENTS_PATH.includes('/hooks/events')).toBe(false);
  });

  it('covers exactly the 7 reporting events — never the worktree events', () => {
    expect([...NATIVE_REPORTER_EVENTS].sort()).toEqual(
      ['PostToolUse', 'PreCompact', 'SessionEnd', 'Stop', 'SubagentStart', 'SubagentStop', 'TaskCompleted'],
    );
  });
});

describe('reconcileReporterHooks (both directions)', () => {
  it('criterion 1: flag off on today\'s generated settings changes nothing', () => {
    const before = todaysSettings();
    const after = JSON.parse(JSON.stringify(before));
    expect(reconcileReporterHooks(after.hooks, { native: false })).toBe(false);
    expect(after).toEqual(before);
  });

  it('criterion 6: flag on rewrites the 7 reporter entries; custom hooks and worktree entries untouched; flag off restores exactly', () => {
    const original = todaysSettings();
    const s = JSON.parse(JSON.stringify(original)) as { hooks: Hooks };
    expect(reconcileReporterHooks(s.hooks, { native: true, baseUrl: 'http://127.0.0.1:4040' })).toBe(true);
    for (const ev of NATIVE_REPORTER_EVENTS) {
      const reporters = s.hooks[ev].flatMap(e => e.hooks).filter(h => isNativeReporterHook(h) || String(h.command ?? '').includes('hook-event-reporter'));
      expect(reporters).toHaveLength(1);
      expect(isNativeReporterHook(reporters[0])).toBe(true);
    }
    // Worktree events keep exactly what today's template has (D3 removes them separately).
    expect(s.hooks.WorktreeCreate).toEqual(original.hooks && (original.hooks as Hooks).WorktreeCreate);
    expect(s.hooks.WorktreeRemove).toEqual((original.hooks as Hooks).WorktreeRemove);
    // Custom + unrelated hooks untouched.
    expect(s.hooks.Stop.some(e => e.hooks.some(h => h.command === 'node my-custom-stop.js'))).toBe(true);
    expect(s.hooks.PostToolUse.some(e => e.hooks.some(h => h.url === 'http://example.test/custom'))).toBe(true);
    expect(s.hooks.PostToolUse.some(e => e.hooks.some(h => String(h.command).includes('working-set-artifact-recorder')))).toBe(true);

    // Idempotent.
    expect(reconcileReporterHooks(s.hooks, { native: true, baseUrl: 'http://127.0.0.1:4040' })).toBe(false);
    // Rollback restores today's settings byte-for-byte.
    expect(reconcileReporterHooks(s.hooks, { native: false })).toBe(true);
    expect(s).toEqual(original);
  });

  it('never emits or restores WorktreeCreate/WorktreeRemove entries in either direction', () => {
    const s = { hooks: { PostToolUse: [{ matcher: '', hooks: [{ ...REPORTER_COMMAND_HOOK }] }] } } as { hooks: Hooks };
    reconcileReporterHooks(s.hooks, { native: true, baseUrl: 'http://127.0.0.1:1' });
    reconcileReporterHooks(s.hooks, { native: false });
    expect(Object.keys(s.hooks)).toEqual(['PostToolUse']);
    // And a worktree reporter that exists is neither converted nor removed.
    const w = { hooks: { WorktreeCreate: [{ matcher: '', hooks: [{ ...REPORTER_COMMAND_HOOK }] }] } } as { hooks: Hooks };
    expect(reconcileReporterHooks(w.hooks, { native: true, baseUrl: 'http://127.0.0.1:1' })).toBe(false);
    expect(w.hooks.WorktreeCreate[0].hooks[0]).toEqual(REPORTER_COMMAND_HOOK);
  });

  it('a port change re-targets the native entry; a duplicated reporter is collapsed to one', () => {
    const s = { hooks: { Stop: [
      { matcher: '', hooks: [buildNativeReporterHook('http://127.0.0.1:4040')] },
      { matcher: '', hooks: [{ ...REPORTER_COMMAND_HOOK }] },
    ] } } as { hooks: Hooks };
    expect(reconcileReporterHooks(s.hooks, { native: true, baseUrl: 'http://127.0.0.1:5050' })).toBe(true);
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.Stop[0].hooks[0].url).toBe('http://127.0.0.1:5050/hooks/native-events');
  });

  it('flag off never touches command reporter entries: a non-canonical command and a second matcher are left exactly as they are', () => {
    const custom = { type: 'command', command: 'node "/abs/path/.instar/hooks/instar/hook-event-reporter.js"', timeout: 10, statusMessage: 'reporting' };
    const s = { hooks: { PostToolUse: [
      { matcher: 'Bash', hooks: [{ ...REPORTER_COMMAND_HOOK }] },
      { matcher: '', hooks: [custom] },
      { matcher: '', hooks: [{ ...REPORTER_COMMAND_HOOK }] },
    ] } } as { hooks: Hooks };
    const before = JSON.stringify(s);
    expect(reconcileReporterHooks(s.hooks, { native: false })).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('flag on keeps one reporter per matcher: reporters under different matchers are each converted, never removed', () => {
    const s = { hooks: { PostToolUse: [
      { matcher: 'Bash', hooks: [{ ...REPORTER_COMMAND_HOOK }] },
      { matcher: '', hooks: [{ ...REPORTER_COMMAND_HOOK }] },
    ] } } as { hooks: Hooks };
    expect(reconcileReporterHooks(s.hooks, { native: true, baseUrl: 'http://127.0.0.1:4040' })).toBe(true);
    expect(s.hooks.PostToolUse).toHaveLength(2);
    expect(s.hooks.PostToolUse.every((e) => isNativeReporterHook(e.hooks[0]))).toBe(true);
    // And back: flag off restores both command entries.
    expect(reconcileReporterHooks(s.hooks, { native: false })).toBe(true);
    expect(s.hooks.PostToolUse.map((e) => e.hooks[0])).toEqual([REPORTER_COMMAND_HOOK, REPORTER_COMMAND_HOOK]);
  });

  it('flag off collapses a native + command pair under one matcher to the command entry', () => {
    const s = { hooks: { Stop: [
      { matcher: '', hooks: [buildNativeReporterHook('http://127.0.0.1:4040'), { ...REPORTER_COMMAND_HOOK }] },
    ] } } as { hooks: Hooks };
    expect(reconcileReporterHooks(s.hooks, { native: false })).toBe(true);
    expect(s.hooks.Stop).toEqual([{ matcher: '', hooks: [REPORTER_COMMAND_HOOK] }]);
  });
});

describe('version / loopback gate (one pure resolver)', () => {
  it('compares versions numerically', () => {
    expect(compareClaudeVersions('2.1.310', '2.1.310')).toBe(0);
    expect(compareClaudeVersions('2.1.309', '2.1.310')).toBeLessThan(0);
    expect(compareClaudeVersions('2.2.0', '2.1.310')).toBeGreaterThan(0);
    expect(compareClaudeVersions('2.1.1000', '2.1.310')).toBeGreaterThan(0);
  });

  it('reads the configured binary (never PATH): a bare name is unreadable', () => {
    expect(resolveSessionClaudeVersion({ claudePath: 'claude', projectDir: '/x' })).toEqual({ readable: false, reason: 'bare-command-name' });
    expect(resolveSessionClaudeVersion({ claudePath: '', projectDir: '/x' }).readable).toBe(false);
  });

  it('reads the version of the retained copy when the retainer is on', () => {
    const root = tmp();
    const bin = fakeClaude(root, '2.1.320');
    const retainedDir = path.join(root, 'claude-bin');
    fs.mkdirSync(path.join(retainedDir, '2.1.320'), { recursive: true });
    fs.writeFileSync(path.join(retainedDir, '2.1.320', 'claude'), 'x');
    const v = resolveSessionClaudeVersion({ claudePath: bin, projectDir: root, retainer: { enabled: true, dir: retainedDir }, versionProbe: () => { throw new Error('no exec'); } });
    expect(v).toMatchObject({ readable: true, version: '2.1.320', source: 'retained' });
    const off = resolveSessionClaudeVersion({ claudePath: bin, projectDir: root, retainer: { enabled: false }, versionProbe: () => { throw new Error('no exec'); } });
    expect(off).toMatchObject({ readable: true, version: '2.1.320', source: 'configured' });
  });

  it('decides native only for flag on + version >= 2.1.310 + loopback; otherwise names the reason', () => {
    const ok = { readable: true as const, version: '2.1.310', launchPath: '/c', source: 'configured' as const };
    expect(decideNativeReporter({ flagEnabled: false, port: 1, version: ok })).toMatchObject({ native: false });
    expect(decideNativeReporter({ flagEnabled: false, port: 1, version: ok }).notInEffect).toBeUndefined();
    expect(decideNativeReporter({ flagEnabled: true, port: 4040, version: ok })).toEqual({ native: true, baseUrl: 'http://127.0.0.1:4040' });
    expect(decideNativeReporter({ flagEnabled: true, port: 4040, version: { ...ok, version: '2.1.309' } }).notInEffect?.reason).toBe('claude-version-too-old');
    expect(decideNativeReporter({ flagEnabled: true, port: 4040, version: { readable: false, reason: 'x' } }).notInEffect?.reason).toBe('claude-version-unreadable');
    expect(decideNativeReporter({ flagEnabled: true, port: 4040, host: '10.0.0.5', version: ok }).notInEffect?.reason).toBe('not-listening-on-loopback');
    expect(nativeHookBaseUrl(4040, '0.0.0.0')).toBe('http://127.0.0.1:4040');
    expect(nativeHookBaseUrl(4040, '::1')).toBe('http://[::1]:4040');
  });

  it('uses the address the server actually binds: a mesh bindHost override counts like an explicit host', () => {
    expect(effectiveListenHost({})).toBeUndefined();
    expect(effectiveListenHost({ host: '127.0.0.1' })).toBe('127.0.0.1');
    expect(effectiveListenHost({ multiMachine: { meshTransport: { bindHost: '100.64.0.9' } } })).toBe('100.64.0.9');
    expect(effectiveListenHost({ host: 'localhost', multiMachine: { meshTransport: { bindHost: '0.0.0.0' } } })).toBe('0.0.0.0');
    expect(effectiveListenHost({ host: '10.0.0.5', multiMachine: { meshTransport: { bindHost: '0.0.0.0' } } })).toBe('10.0.0.5');
    const d = decideNativeReporterFromConfig(
      { hooks: { nativeEventReporter: { enabled: true } }, multiMachine: { meshTransport: { bindHost: '100.64.0.9' } } },
      { projectDir: '/nonexistent', port: 4040, claudeCodePath: null },
    );
    expect(d.notInEffect?.reason).toBe('not-listening-on-loopback');
  });
});

describe('PostUpdateMigrator.migrateSettings (update path)', () => {
  let root: string;
  let stateDir: string;
  let settingsPath: string;
  let claudeBin: string;

  function writeConfig(extra: Record<string, unknown>): void {
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 't', port: 4040, ...extra }, null, 2));
  }
  function migrate(claudeCodePath: string | null = claudeBin): { upgraded: string[]; skipped: string[]; errors: string[] } {
    const m = new PostUpdateMigrator({ projectDir: root, stateDir, port: 4040, hasTelegram: false, projectName: 't', claudeCodePath });
    const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    (m as unknown as { migrateSettings(r: unknown): void }).migrateSettings(result);
    return result;
  }
  const read = () => JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  const reporterHooks = (s: { hooks: Hooks }, ev: string) =>
    (s.hooks[ev] ?? []).flatMap(e => e.hooks).filter(h => isNativeReporterHook(h) || String(h.command ?? '').includes('hook-event-reporter'));

  beforeEach(() => {
    root = tmp();
    stateDir = path.join(root, '.instar');
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    settingsPath = path.join(root, '.claude', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(todaysSettings(), null, 2));
    claudeBin = fakeClaude(root, '2.1.310');
  });

  it('criterion 1: flag off (default) leaves every reporter entry as today\'s command entry', () => {
    writeConfig({});
    migrate();
    const s = read();
    for (const ev of NATIVE_REPORTER_EVENTS) {
      expect(reporterHooks(s, ev)).toEqual([REPORTER_COMMAND_HOOK]);
    }
  });

  it('criteria 6 + 3c: flag on rewrites the 7 entries; a second migrateSettings run changes nothing; old http-hook migrations leave it alone', () => {
    writeConfig({ hooks: { nativeEventReporter: { enabled: true } } });
    const r1 = migrate();
    expect(r1.upgraded.some(u => u.includes('native http'))).toBe(true);
    const s1 = read();
    for (const ev of NATIVE_REPORTER_EVENTS) {
      const r = reporterHooks(s1, ev);
      expect(r).toHaveLength(1);
      expect(r[0]).toEqual(buildNativeReporterHook('http://127.0.0.1:4040'));
    }
    const snapshot = fs.readFileSync(settingsPath, 'utf-8');
    const r2 = migrate();
    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(snapshot);
    // None of the legacy http-hook migrations reported touching it.
    expect(r2.upgraded.filter(u => /HTTP hook|instar_sid|replaced HTTP hooks|added \d+ HTTP hooks/.test(u))).toEqual([]);
    // The native URL carries no instar_sid rewrite.
    expect(JSON.stringify(read())).not.toContain('instar_sid');
  });

  it('criterion 6: flag on → off restores today\'s command entries exactly', () => {
    writeConfig({ hooks: { nativeEventReporter: { enabled: true } } });
    migrate();
    writeConfig({ hooks: { nativeEventReporter: { enabled: false } } });
    migrate();
    const restored = read();
    for (const ev of NATIVE_REPORTER_EVENTS) {
      expect(reporterHooks(restored, ev)).toEqual([REPORTER_COMMAND_HOOK]);
    }
    // Custom hooks survived both directions.
    expect(restored.hooks.Stop.some((e: { hooks: Array<{ command?: string }> }) => e.hooks.some(h => h.command === 'node my-custom-stop.js'))).toBe(true);
  });

  it('criterion 6: Claude Code below 2.1.310 keeps the command entries (and records why)', () => {
    writeConfig({ hooks: { nativeEventReporter: { enabled: true } } });
    const oldBin = fakeClaude(path.join(root, 'old'), '2.1.300');
    const r = migrate(oldBin);
    for (const ev of NATIVE_REPORTER_EVENTS) {
      expect(reporterHooks(read(), ev)).toEqual([REPORTER_COMMAND_HOOK]);
    }
    expect(r.skipped.some(sk => sk.includes('claude-version-too-old'))).toBe(true);
  });

  it('criterion 6: an unreadable version keeps the command entries', () => {
    writeConfig({ hooks: { nativeEventReporter: { enabled: true } } });
    migrate(null); // config.json carries no claude path either
    for (const ev of NATIVE_REPORTER_EVENTS) {
      expect(reporterHooks(read(), ev)).toEqual([REPORTER_COMMAND_HOOK]);
    }
  });
});

describe('server boot reconcile + launch-time check', () => {
  it('criterion 6: below 2.1.310 ⇒ command entries kept + exactly one degradation report per boot', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(todaysSettings(), null, 2));
    const bin = fakeClaude(root, '2.1.200');
    const decision = decideNativeReporterFromConfig(
      { port: 4040, hooks: { nativeEventReporter: { enabled: true } }, sessions: { claudePath: bin } },
      { projectDir: root },
    );
    const reports: string[] = [];
    const boot = bootReconcileNativeReporter({ projectDir: root, decision, reportNotInEffect: (reason) => reports.push(reason), log: () => {} });
    boot.launchCheck();
    boot.launchCheck();
    expect(reports).toEqual(['claude-version-too-old']);
    const s = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf-8'));
    expect(JSON.stringify(s)).not.toContain(NATIVE_HOOK_EVENTS_PATH);
  });

  it('criterion 6a: a settings file overwritten between boot and spawn is rewritten by the launch check', () => {
    const root = tmp();
    const settingsPath = path.join(root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(todaysSettings(), null, 2));
    const bin = fakeClaude(root, '2.1.310');
    const decision = decideNativeReporterFromConfig(
      { port: 4321, hooks: { nativeEventReporter: { enabled: true } }, sessions: { claudePath: bin } },
      { projectDir: root },
    );
    const boot = bootReconcileNativeReporter({ projectDir: root, decision, log: () => {} });
    expect(boot.changedAtBoot).toBe(true);
    // A git sync lands another machine's copy (command entries + a foreign port).
    const foreign = todaysSettings() as { hooks: Hooks };
    foreign.hooks.Stop[0].hooks[0] = buildNativeReporterHook('http://127.0.0.1:9999');
    fs.writeFileSync(settingsPath, JSON.stringify(foreign, null, 2));
    expect(boot.launchCheck()).toBe(true);
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { hooks: Hooks };
    for (const ev of NATIVE_REPORTER_EVENTS) {
      const r = s.hooks[ev].flatMap(e => e.hooks).filter(isNativeReporterHook);
      expect(r).toHaveLength(1);
      expect(r[0].url).toBe('http://127.0.0.1:4321/hooks/native-events');
    }
    expect(boot.launchCheck()).toBe(false); // idempotent
  });

  it('criterion 6a: the launcher runs the check immediately before a claude-code spawn (and only for claude-code)', async () => {
    const { SessionManager } = await import('../../src/core/SessionManager.js');
    const calls: string[] = [];
    const fake = { nativeHookLaunchCheck: () => { calls.push('check'); }, claudeLaunchVersions: new Map(), claudeBinaryRetainer: { resolve: (p: string) => ({ path: p, source: 'original', version: null }) } };
    const resolve = SessionManager.prototype.resolveLaunchBinary;
    expect(resolve.call(fake as never, 'claude-code' as never, '/bin/claude')).toBe('/bin/claude');
    expect(resolve.call(fake as never, 'codex-cli' as never, '/bin/codex')).toBe('/bin/codex');
    expect(calls).toEqual(['check']);
  });
});
