/**
 * A real AgentServer (production constructor) with a real, never-started TelegramAdapter over a
 * generated Telegram log, for docs/specs/conversation-list-offthread-scan.md tests.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from './setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { wireReadMarkerStore } from '../../src/core/ConversationReadMarkersWiring.js';

export interface OffthreadScanServer {
  server: AgentServer; telegram: TelegramAdapter; config: InstarConfig; logPath: string;
  list: () => request.Test;
  chat: (topicId: number, limit?: number) => request.Test;
  /** Forget every cached topic tail: the cold state right after a restart. */
  coldCache: () => void;
  close: () => Promise<void>;
}

/** `topics` closed topics with `perTopic` rows each; `padBytes` of text per row sets the log size. */
export async function startOffthreadScanServer(opts: { topics: number; perTopic: number; padBytes: number; label: string }): Promise<OffthreadScanServer> {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'clist-offthread-'));
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'offthread machine' });
  const logPath = path.join(stateDir, 'telegram-messages.jsonl');
  const pad = 'p'.repeat(opts.padBytes);
  const fd = fs.openSync(logPath, 'w');
  try {
    let id = 1; const chunk: string[] = [];
    // Interleaved, as a real log is: round k of every topic, then round k+1.
    for (let k = 0; k < opts.perTopic; k++) {
      for (let t = 1; t <= opts.topics; t++, id++) {
        chunk.push(JSON.stringify({ messageId: id, topicId: 7000 + t, text: `note ${k} for ${t} ${pad}`, fromUser: k % 3 === 0, timestamp: new Date(1_700_000_000_000 + id * 1000).toISOString(), sessionName: null }));
      }
      if (chunk.length > 5000) { fs.writeSync(fd, chunk.join('\n') + '\n'); chunk.length = 0; }
    }
    if (chunk.length) fs.writeSync(fd, chunk.join('\n') + '\n');
  } finally { fs.closeSync(fd); }
  const telegram = new TelegramAdapter({ token: 'test-token', chatId: '-100123' }, stateDir);
  for (let t = 1; t <= opts.topics; t++) { telegram.registerTopicSession(7000 + t, `s-${t}`, `Planning notes ${t}`); telegram.unregisterTopic(7000 + t); }
  const config = {
    projectName: opts.label, projectDir: dir, stateDir, port: 0, authToken: 'offthread-token', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false } },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {}, threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const readMarkers = wireReadMarkerStore({ stateDir, emitter: null, peerStreams: null, ownMachineId: null, report: () => undefined, removalEvidence: () => false });
  readMarkers.markCatchUpSettled();
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), telegram, readMarkers } as never);
  const auth = (t: request.Test) => t.set('Authorization', 'Bearer offthread-token').set('X-Instar-AgentId', opts.label);
  return {
    server, telegram, config, logPath,
    list: () => auth(request(server.getApp()).get('/mobile/conversations?limit=200')),
    chat: (topicId, limit = 50) => auth(request(server.getApp()).get(`/telegram/topics/${topicId}/messages?limit=${limit}`)),
    coldCache: () => {
      const inner = telegram as unknown as { topicTailCache: Map<number, unknown>; tailCacheSeeded: boolean };
      inner.topicTailCache.clear(); inner.tailCacheSeeded = false;
    },
    close: async () => {
      await server.stop();
      await telegram.stop();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/helpers/offthreadScanServer.ts' });
    },
  };
}

/** The switch, set the way an operator sets it (the config the server reads live). */
export function setOffMainThread(s: OffthreadScanServer, on: boolean | undefined): void {
  const c = s.config as unknown as { telegramHistoryScan?: { offMainThread?: boolean } };
  if (on === undefined) delete c.telegramHistoryScan; else c.telegramHistoryScan = { offMainThread: on };
}
