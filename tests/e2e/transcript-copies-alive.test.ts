// @ts-nocheck — production boot path exercised over real HTTP.
/**
 * native-conversation-any-machine-access §3f — Tier-3 "feature is alive".
 *
 * The source machine cuts checkpoints through a REAL CoherenceJournal and the REAL generic
 * ReplicatedRecordEmitter (the same `journalCheckpointEmit` server.ts uses), so the new kind must be
 * a registered journal kind under the 80 KiB line cap. The reading machine applies the source's
 * stream with a REAL JournalSyncApplier, whose commit observer lands each entry in the copy store as
 * server.ts wires it. Then an AgentServer on the production init path, whose signed read of the
 * sleeping source times out, answers GET /sessions/NAME/transcript from the copy (200, `via: copy`)
 * and GET /transcript-copies answers 200, not 503. The source checks prove server.ts registers the
 * kind, wires the observer and hands the store and the tick to AgentServer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { CoherenceJournal, sanitizeMachineId } from '../../src/core/CoherenceJournal.js';
import { JournalSyncApplier } from '../../src/core/JournalSyncApplier.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import {
  SESSION_TRANSCRIPTS_KIND_REGISTRATION, SESSION_TRANSCRIPT_CHECKPOINT_KIND, wireTranscriptCopies, journalCheckpointEmit,
} from '../../src/core/transcriptCheckpoints.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); }, 30_000);
const tmpBase = () => (process.env.TMPDIR && !process.env.TMPDIR.includes('/.') ? process.env.TMPDIR : os.tmpdir());
function agentDir(label) {
  const root = fs.mkdtempSync(path.join(tmpBase(), `tc-alive-${label}-`)), stateDir = path.join(root, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  cleanup.push(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'transcript-copies-alive' }));
  return { root, stateDir };
}

describe('transcript copies lifecycle', () => {
  it('server.ts registers the kind, lands peer commits in the copy store and hands both seams to AgentServer', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8');
    expect(src).toContain('replicatedKindRegistry.register(SESSION_TRANSCRIPTS_KIND_REGISTRATION);');
    expect(src).toContain("if (kind === 'session-transcript-checkpoint') _transcriptCopyIngest?.(senderMachineId, entries);");
    expect(src).toContain('emit: tcMod.journalCheckpointEmit(replicatedRecordEmitter, coherenceJournal),');
    expect(src).toContain('const wired = tcMod.wireTranscriptCopies({');
    expect(src).toContain('_transcriptCopyIngest = wired.ingest;');
    expect(src).toContain('_transcriptCheckpointTick = wired.tick;');
    expect(src).toContain('transcriptCopies: _transcriptCopies ?? undefined, transcriptCheckpointTick: _transcriptCheckpointTick ?? undefined');
    expect(src).toContain("sessionManager.on('sessionComplete', (session) => _transcriptCheckpointFinal?.(session));");
    const agent = fs.readFileSync(path.join(process.cwd(), 'src/server/AgentServer.ts'), 'utf8');
    expect(agent).toContain('transcriptCopies: options.transcriptCopies ?? null');
    expect(agent).toContain('await this.transcriptCheckpointTick?.();');
  });

  it('is alive: a checkpoint crosses a real journal and applier and is read from the copy while the source sleeps', async () => {
    const SRC = 'm_src_alive', READER = 'm_reader_alive';
    // ── The source machine: a real journal, the real emitter ──
    const s = agentDir('src');
    const registry = new ReplicatedKindRegistry();
    registry.register(SESSION_TRANSCRIPTS_KIND_REGISTRATION);
    const journal = new CoherenceJournal({ stateDir: s.stateDir, machineId: SRC, flushIntervalMs: 20 });
    journal.setReplicatedKindRegistry(registry);
    journal.open();
    cleanup.push(() => journal.close());
    let n = 0;
    const emitter = new ReplicatedRecordEmitter({
      journal, clock: { tick: () => ({ physical: Date.now(), logical: n++, node: SRC }) }, registry, origin: SRC,
      stores: () => ({ sessionTranscripts: { enabled: true } }), loadWitness: () => undefined,
    });
    const transcript = path.join(s.root, 'session.jsonl');
    fs.writeFileSync(transcript, [
      { type: 'user', timestamp: '2026-11-11T14:00:00Z', message: { content: 'what is on the Mini?' } },
      { type: 'assistant', timestamp: '2026-11-11T14:02:00Z', message: { content: [{ type: 'text', text: 'Read from the copy while the Mini sleeps. src-token-xyz' }] } },
      { type: 'user', timestamp: '2026-11-11T14:03:00Z', message: { content: 'x'.repeat(120_000) } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    // The same wiring function server.ts calls, with the real journal emit.
    const wiredSource = wireTranscriptCopies({
      stateDir: s.stateDir, machineId: SRC, secrets: () => ['src-token-xyz'], emit: journalCheckpointEmit(emitter, journal),
      listSessions: () => [{ id: 'claude-alive', claudeSessionId: 'claude-alive', status: 'running', tmuxSession: 'echo-on-mini' }],
      describe: () => ({ filePath: transcript, conversations: [] }),
    });
    await wiredSource.tick();
    expect(wiredSource.source.state('claude-alive')).toMatchObject({ seq: 1, pending: null });
    await wiredSource.final({ id: 'claude-alive', claudeSessionId: 'claude-alive', status: 'completed', tmuxSession: 'echo-on-mini' });
    expect(wiredSource.source.state('claude-alive')).toMatchObject({ seq: 2, pending: null, finalRequested: false });

    // ── The reading machine: the source's stream applied by a real applier ──
    const r = agentDir('reader');
    const reading = wireTranscriptCopies({ stateDir: r.stateDir, machineId: READER, secrets: () => [], emit: async () => true, listSessions: () => [], describe: () => ({ filePath: null, conversations: [] }) });
    const copies = reading.store;
    const applier = new JournalSyncApplier({ stateDir: r.stateDir, replicatedRegistry: registry, onReplicatedRecordsCommitted: (sender, kind, entries) => {
      if (kind === SESSION_TRANSCRIPT_CHECKPOINT_KIND) reading.ingest(sender, entries);
    } });
    const streamFile = path.join(s.stateDir, 'state', 'coherence-journal', `${sanitizeMachineId(SRC)}.${SESSION_TRANSCRIPT_CHECKPOINT_KIND}.jsonl`);
    const entries = fs.readFileSync(streamFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(entries.length).toBeGreaterThan(2); // the 120 KB row needs several journal entries
    const incarnation = journal.streamStatuses().find((x) => x.kind === SESSION_TRANSCRIPT_CHECKPOINT_KIND).incarnation;
    const applied = applier.apply(SRC, [{ kind: SESSION_TRANSCRIPT_CHECKPOINT_KIND, incarnation, entries }]);
    expect(applied).toMatchObject({ applied: entries.length, forgedEntries: 0, invalidEntries: 0 });
    // A peer relaying the source's checkpoints as its own is refused by the applier.
    const relayed = applier.apply('m_relay', [{ kind: SESSION_TRANSCRIPT_CHECKPOINT_KIND, incarnation, entries: entries.map((e) => ({ ...e, machine: 'm_relay' })) }]);
    expect(relayed.applied).toBe(0);
    expect(copies.manifest(SRC, 'claude-alive')).toMatchObject({ complete: true, rowCount: 3, nextSeq: 3 });

    const config = { projectName: 'tc-reader', projectDir: r.root, stateDir: r.stateDir, port: 0, authToken: 'reader-token', dashboardPin: '555666' };
    const server = new AgentServer({
      config, state: new StateManager(r.stateDir), sessionManager: createMockSessionManager(), meshSelfId: READER,
      resolvePeerUrls: () => [{ machineId: SRC, url: 'http://127.0.0.1:9', kind: 'lan' }],
      meshSignedRead: () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      transcriptCopies: reading.copies,
    });
    cleanup.push(() => server.stop());
    const http = server.getApp().listen(0, '127.0.0.1');
    cleanup.push(() => new Promise((resolve) => http.close(resolve)));
    await new Promise((resolve) => (http.listening ? resolve() : http.once('listening', resolve)));
    const url = `http://127.0.0.1:${http.address().port}`;
    const auth = { Authorization: 'Bearer reader-token', 'X-Instar-AgentId': 'tc-reader' };

    const res = await fetch(`${url}/sessions/echo-on-mini/transcript?machineId=${SRC}&full=1`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, via: 'copy', machineId: SRC, copy: { complete: true, sourceAwake: false } });
    expect(body.entries.map((e) => e.text.slice(0, 40))).toEqual(['what is on the Mini?', 'Read from the copy while the Mini sleeps', 'x'.repeat(40)]);
    expect(JSON.stringify(body)).not.toContain('src-token-xyz');

    const status = await fetch(`${url}/transcript-copies`, { headers: auth });
    expect(status.status).toBe(200);
    expect((await status.json()).copies).toEqual([expect.objectContaining({ sourceMachineId: SRC, session: 'echo-on-mini', complete: true })]);
  }, 60_000);
});
