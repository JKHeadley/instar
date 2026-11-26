// safe-fs-allow: isolated fixture directories only, no agent or session processes.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import { PresenceProxy } from '../../src/monitoring/PresenceProxy.js';
import { confirmSessionUsageLimit } from '../../src/monitoring/sessionUsageLimitEvidence.js';
import { computeWorkingSet } from '../../src/core/WorkingSetManifest.js';

const dirs: string[] = [];
const proxies: PresenceProxy[] = [];
afterEach(() => { proxies.forEach(p => p.stop()); dirs.splice(0).forEach(d => SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'usage-limit-test:cleanup' })); });
function home() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-lifecycle-')); dirs.push(d); return d; }

describe('serving-session limit notice lifecycle', () => {
  it('corroborates the parent, carries one notice across transfer, then permits a new session', async () => {
    const source = home(), target = home();
    const transcript = path.join(source, 'parent.jsonl');
    let sessionId = 'parent-uuid';
    const writeError = () => fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', sessionId, error: 'rate_limit', isApiErrorMessage: true }) + '\n');
    writeError();
    let sends = 0;
    const make = (stateDir: string) => {
      const p = new PresenceProxy({ stateDir, intelligence: null, agentName: 'Echo',
        getSessionForTopic: () => 'serving', isSessionAlive: () => true, getProcessTree: () => [], getAuthorizedUserIds: () => [],
        captureSessionOutput: () => "You've hit your weekly limit · resets 11am\n❯",
        confirmSessionUsageLimit: () => confirmSessionUsageLimit(transcript, sessionId) ? sessionId : false,
        sendMessage: async () => { sends++; } });
      p.start(); proxies.push(p); return p as any;
    };
    const trigger = async (p: any) => {
      p.onMessageLogged({ channelId: '123', fromUser: true, text: 'continue' });
      await p.fireTier1(123, p.states.get(123));
    };
    const oldOwner = make(source);
    await trigger(oldOwner);
    const manifest = computeWorkingSet({ stateDir: source, topic: 123, runs: { artifactPaths: [], liveRun: false, evidenceTruncated: false } as any });
    const notice = manifest.entries.find(e => e.relPath === 'autonomous/123.usage-limit-notice.json');
    expect(notice).toBeDefined();
    fs.mkdirSync(path.join(target, 'autonomous'), { recursive: true });
    fs.copyFileSync(path.join(source, notice!.relPath), path.join(target, notice!.relPath));
    oldOwner.stop();
    const newOwner = make(target);
    await trigger(newOwner);
    expect(sends).toBe(1);
    newOwner.onMessageLogged({ channelId: '123', fromUser: false, sessionName: 'serving', text: 'I finished the requested work.' });
    // Clears are durable too: returning to an old owner must overwrite its
    // stale budget rather than relying on deletion to propagate.
    const carriedClear = path.join(target, 'autonomous/123.usage-limit-notice.json');
    expect(JSON.parse(fs.readFileSync(carriedClear, 'utf8')).sessionName).toBeNull();
    fs.copyFileSync(carriedClear, path.join(source, notice!.relPath));
    expect(JSON.parse(fs.readFileSync(path.join(source, notice!.relPath), 'utf8')).sessionName).toBeNull();
    newOwner.stop(); oldOwner.start();
    writeError();
    await trigger(oldOwner);
    expect(sends).toBe(2); // same provider UUID; the carried clear reopened it
    oldOwner.stop(); newOwner.start();
    // Same tmux label, different actual provider session: a distinct wall.
    sessionId = 'replacement-uuid'; writeError();
    await trigger(newOwner);
    expect(sends).toBe(3);
  });
});
