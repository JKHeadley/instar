import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ConversationPreferencesStore } from '../../src/core/ConversationPreferences.js';
import { MobileChatRequestStore } from '../../src/core/MobileChatRequests.js';
import { recoverPreferenceRequests, preferenceReceipt } from '../../src/server/conversationPreferenceRequests.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
it('boot recovery applies only the exact reserved atomic preference batch and keeps its receipt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preference-recovery-'));
  try {
    const store = new ConversationPreferencesStore({ stateDir: dir });
    const requests = new MobileChatRequestStore(dir);
    const requestId = `${Date.now()}-${crypto.randomUUID()}`; const ref = `app:${crypto.randomUUID()}`;
    const rows = store.prepareOperation('owner', ref, { muted: true, archived: true });
    expect(requests.reserve('device', requestId, 'intent', 0, { op: 'preferences', reader: 'owner', ref, events: JSON.stringify(rows) }).kind).toBe('reserved');
    // A new boot sees the reserved operation, not an active request in its own process.
    const rebootedRequests = new MobileChatRequestStore(dir);
    recoverPreferenceRequests(store, rebootedRequests);
    expect(store.get('owner', ref)).toEqual({ muted: true, archived: true });
    expect(rebootedRequests.lookup('device', requestId, 'intent')).toMatchObject({ kind: 'done', body: { saveReceipt: preferenceReceipt(requestId, ref, rows) } });
    const generation = store.generation;
    recoverPreferenceRequests(store, rebootedRequests);
    expect(store.generation).toBe(generation); expect(store.rows()).toEqual(rows);
  } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/conversation-preference-requests.test.ts' }); }
});
