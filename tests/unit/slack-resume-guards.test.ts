// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Slack resume records carry their engine and id source, and keep still while an engine switch is
 * under way (docs/specs/session-swap-any-conversation.md §3.1).
 */
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';

const dirs: string[] = [];
function make() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-resume-guards-'));
  dirs.push(stateDir);
  const adapter = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test', authorizedUserIds: ['U_TEST'], workspaceMode: 'dedicated' } as any, stateDir);
  return { adapter, stateDir };
}
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/slack-resume-guards.test.ts' }); });

describe('Slack resume record guards', () => {
  it('without guards it saves as before (no engine stored), and a legacy record serves only the agent default', () => {
    const { adapter } = make();
    adapter.saveChannelResume('C0ABC', 'uuid-1', 'sess');
    expect(adapter.getChannelResume('C0ABC', { framework: 'codex-cli', legacyOk: false })).toBeNull();
    expect(adapter.getChannelResume('C0ABC', { framework: 'claude-code', legacyOk: true })).toMatchObject({ uuid: 'uuid-1' });
    expect(adapter.getChannelResume('C0ABC')).toMatchObject({ uuid: 'uuid-1' });
  });
  it('stores the session\'s engine and where its id came from', () => {
    const { adapter } = make();
    adapter.setResumeGuards({ sessionFacts: () => ({ framework: 'claude-code', hookId: 'uuid-h' }), writeGate: () => ({ allowed: true }) });
    adapter.saveChannelResume('C0ABC', 'uuid-h', 'sess');
    expect(adapter.peekChannelResume('C0ABC')).toEqual({ uuid: 'uuid-h', framework: 'claude-code', provenance: 'hook' });
    adapter.saveChannelResume('C0ABC', 'uuid-m', 'sess');
    expect(adapter.peekChannelResume('C0ABC')).toMatchObject({ provenance: 'mtime' });
    // A spawn on another engine never resumes it.
    expect(adapter.getChannelResume('C0ABC', { framework: 'codex-cli', legacyOk: true })).toBeNull();
  });
  it('the write gate is asked with the Slack profile key and the session\'s engine; a refusal saves nothing', () => {
    const { adapter } = make();
    const asked: Array<[string, string | null]> = [];
    adapter.setResumeGuards({ sessionFacts: () => ({ framework: 'codex-cli', hookId: null }), writeGate: (k, f) => { asked.push([k, f]); return { allowed: false, reason: 'mid-framework-switch' }; } });
    adapter.saveChannelResume('C0ABC:1730000000.000100', 'uuid-1', 'sess');
    expect(asked).toEqual([['slack:C0ABC:1730000000.000100', 'codex-cli']]);
    expect(adapter.peekChannelResume('C0ABC:1730000000.000100')).toBeNull();
  });
  it('a parked record is hidden, and unpark restores it (idempotent both ways)', () => {
    const { adapter, stateDir } = make();
    adapter.setResumeGuards({ sessionFacts: () => ({ framework: 'claude-code', hookId: 'uuid-1' }), writeGate: () => ({ allowed: true }) });
    adapter.saveChannelResume('C0ABC', 'uuid-1', 'sess');
    adapter.parkChannelResume('C0ABC', 'mid-framework-switch');
    adapter.parkChannelResume('C0ABC', 'again');
    expect(adapter.peekChannelResume('C0ABC')).toBeNull();
    expect(adapter.getChannelResume('C0ABC')).toBeNull();
    // Survives a restart of the adapter (on disk).
    const reread = JSON.parse(fs.readFileSync(path.join(stateDir, 'slack-channel-resume-map.json'), 'utf-8'));
    expect(reread.C0ABC).toMatchObject({ uuid: 'uuid-1', parked: { reason: 'mid-framework-switch' } });
    expect(adapter.unparkChannelResume('C0ABC')).toBe(true);
    expect(adapter.unparkChannelResume('C0ABC')).toBe(false);
    expect(adapter.peekChannelResume('C0ABC')).toMatchObject({ uuid: 'uuid-1' });
  });
  it('after a switch lands, the new session\'s save replaces the parked record (as Telegram\'s map does)', () => {
    const { adapter } = make();
    let gateOpen = true;
    adapter.setResumeGuards({ sessionFacts: (n) => ({ framework: n === 'new' ? 'codex-cli' : 'claude-code', hookId: null }), writeGate: () => ({ allowed: gateOpen }) });
    adapter.saveChannelResume('C0ABC', 'old', 'old');
    adapter.parkChannelResume('C0ABC', 'mid-framework-switch');
    // Mid-switch the gate refuses the old session's kill-time save.
    gateOpen = false;
    adapter.saveChannelResume('C0ABC', 'old-again', 'old');
    expect(adapter.peekChannelResume('C0ABC')).toBeNull();
    // The switch landed: the new session's heartbeat save is the one kept.
    gateOpen = true;
    adapter.saveChannelResume('C0ABC', 'new-id', 'new');
    expect(adapter.peekChannelResume('C0ABC')).toMatchObject({ uuid: 'new-id', framework: 'codex-cli' });
  });
  it('a parked record older than a day is dropped', () => {
    const { adapter, stateDir } = make();
    adapter.saveChannelResume('C0ABC', 'u', 's');
    adapter.parkChannelResume('C0ABC', 'x');
    const f = path.join(stateDir, 'slack-channel-resume-map.json');
    const m = JSON.parse(fs.readFileSync(f, 'utf-8'));
    m.C0ABC.savedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
    fs.writeFileSync(f, JSON.stringify(m));
    const again = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test', authorizedUserIds: ['U_TEST'], workspaceMode: 'dedicated' } as any, stateDir);
    expect(again.peekChannelResume('C0ABC')).toBeNull();
    expect(JSON.parse(fs.readFileSync(f, 'utf-8')).C0ABC).toBeUndefined();
  });
});
