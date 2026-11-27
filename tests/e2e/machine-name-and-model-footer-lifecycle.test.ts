/**
 * Operator report 2026-11-12: a Claude Code reply footer read
 * "bob · Machine m_4851af · Claude Code · unknown". This drives the production paths end to end:
 *   1. An agent whose machine registry predates nicknames boots its coordinator (as server.ts
 *      does) and the machine comes out with a human name, the same one the footer reads.
 *   2. A Claude Code session whose transcript holds a record larger than one observer read
 *      (a screenshot) answers its real model at send time, and the footer shows it.
 *   3. A model that genuinely cannot be known is left out of the footer.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { RuntimeOriginObserver } from '../../src/messaging/telegram-origin/RuntimeOriginObserver.js';
import { originFooter, resolveOriginDisplay } from '../../src/messaging/telegram-origin/OriginPresentation.js';
import type { TelegramOriginProducer } from '../../src/messaging/telegram-origin/types.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) SafeFsExecutor.safeRmSync(r, { recursive: true, force: true, operation: 'machine-name-and-model-footer-lifecycle:cleanup' }); });

describe('machine name and model in the reply footer (production boot path)', () => {
  it('an unnamed machine is named at boot and a Claude session reports its real model', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'footer-lifecycle-'));
    roots.push(root);
    const stateDir = path.join(root, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const identity = await new MachineIdentityManager(stateDir, { detectFriendlyName: () => "Bob's Mac mini" }).generateIdentity({ name: 'bob' });
    // An older registry: the entry carries no nickname.
    const registryPath = new MachineIdentityManager(stateDir).registryPath;
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    delete registry.machines[identity.machineId].nickname;
    delete registry.machines[identity.machineId].nicknameSource;
    fs.writeFileSync(registryPath, JSON.stringify(registry));

    // The server boot: the coordinator starts and self-heals the registry (real detector on this host).
    const coordinator = new MultiMachineCoordinator(new StateManager(stateDir), { stateDir });
    coordinator.start();
    coordinator.stop();
    const entry = new MachineIdentityManager(stateDir).loadRegistry().machines[identity.machineId];
    expect(entry.nickname, 'the machine has a human name after boot').toBeTruthy();
    expect(entry.nickname).not.toMatch(/^Machine |^m_/);
    // The Telegram origin boot reads exactly this field for the footer machine name.
    const machineName = entry.nickname!;

    // A Claude Code transcript with a 400 KB record (a screenshot) before the authored reply.
    const native = '22222222-2222-4222-8222-222222222222';
    const transcript = path.join(root, `${native}.jsonl`);
    const row = (r: Record<string, unknown>) => JSON.stringify({ sessionId: native, ...r }) + '\n';
    fs.writeFileSync(transcript,
      row({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Look at this screenshot' } }) +
      row({ type: 'user', uuid: 'img', message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'image', source: { data: 'A'.repeat(400_000) } }] }] } }) +
      row({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'claude-opus-5-5', content: [] } }));
    const observer = new RuntimeOriginObserver();
    observer.track({ agentId: 'bob', machineId: identity.machineId, sessionId: 's1', sessionIncarnation: 'i1', issuedAt: new Date().toISOString(),
      harnessId: 'claude-code', projectDir: root, nativeSessionId: native }, { path: transcript, nativeSessionId: native });
    // What TelegramOriginService.sessionProducer does at send time.
    await observer.refresh('s1', { catchUp: true });
    const model = observer.get('s1')!.model;
    expect(model).toMatchObject({ status: 'observed', value: 'claude-opus-5-5' });
    observer.stop();

    const evidence = (value: string | null, status: 'observed' | 'unknown') => ({ value, status, sourceEventRef: null, observedAt: 1, reason: null });
    const producer: TelegramOriginProducer = {
      agentId: 'bob', agentName: 'bob', originMachineId: identity.machineId, originMachineName: machineName,
      sessionId: 's1', sessionIncarnation: 'i1', turnId: 'u1', producerKind: 'session', producerId: 's1',
      harnessId: 'claude-code', harnessName: 'Claude Code',
      machine: evidence(machineName, 'observed'), harness: evidence('claude-code', 'observed'), model: evidence(model.value, 'observed'),
    };
    expect(originFooter(producer, resolveOriginDisplay())).toBe(`bob · ${machineName} · Claude Code · claude-opus-5-5`);
    // Genuinely unknown: left out, never the word "unknown".
    expect(originFooter({ ...producer, model: evidence(null, 'unknown') }, resolveOriginDisplay())).toBe(`bob · ${machineName} · Claude Code`);
  });
});
