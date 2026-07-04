// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Unit (Tier 1) — verifyConversationBind, the ONE shared §7 bind-verify helper
 * (slack-followthrough-generalization §4.3). Both sides of every decision boundary:
 * minted (negative) ids are fail-closed; positive ids ride legacy/token-bearing arms;
 * refusals raise the deduped attention item. Shared by POST /commitments AND
 * /action-claim/observe — this test pins the ONE implementation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyConversationBind } from '../../src/core/conversationBindGate.js';
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';

let dir: string;
let attention: { items: Array<{ id: string; priority: string }> };
const sink = () => ({
  createAttentionItem: (i: any) => {
    attention.items.push({ id: i.id, priority: i.priority });
    return i;
  },
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbg-'));
  attention = { items: [] };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('verifyConversationBind — minted (negative) ids: fail-closed', () => {
  it('valid token whose bootstrap set includes the id → ok + session boundBy', () => {
    const auth = createConversationBindAuth(dir);
    const token = auth.mint('agent-slack-thread', [-501]);
    const v = verifyConversationBind({ bindAuth: auth, numericTopicId: -501, rawToken: token, attention: sink() });
    expect(v).toEqual({ ok: true, boundBy: 'session:agent-slack-thread' });
    expect(attention.items).toHaveLength(0);
  });

  it('MISSING token → refuse + deduped attention item', () => {
    const auth = createConversationBindAuth(dir);
    const v = verifyConversationBind({ bindAuth: auth, numericTopicId: -501, rawToken: undefined, attention: sink() });
    expect(v.ok).toBe(false);
    expect(attention.items).toEqual([{ id: 'conversation-bind-refused:-501', priority: 'NORMAL' }]);
  });

  it('FOREIGN id (not in the token bootstrap set) → refuse', () => {
    const auth = createConversationBindAuth(dir);
    const token = auth.mint('agent-slack-thread', [-501]);
    const v = verifyConversationBind({ bindAuth: auth, numericTopicId: -999, rawToken: token, attention: sink() });
    expect(v.ok).toBe(false);
    expect(attention.items[0].id).toBe('conversation-bind-refused:-999');
  });

  it('token minted by a DIFFERENT secret (wrong machine) → refuse (MAC fails)', () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cbg2-'));
    try {
      const foreignToken = createConversationBindAuth(dir2).mint('s', [-501]);
      const localAuth = createConversationBindAuth(dir);
      const v = verifyConversationBind({ bindAuth: localAuth, numericTopicId: -501, rawToken: foreignToken, attention: sink() });
      expect(v.ok).toBe(false);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});

describe('verifyConversationBind — positive ids: legacy + token-bearing arms', () => {
  it('token-bearing positive id in the bootstrap set → ok + boundBy (R6-minor-4)', () => {
    const auth = createConversationBindAuth(dir);
    const token = auth.mint('agent-topic', [7]);
    const v = verifyConversationBind({ bindAuth: auth, numericTopicId: 7, rawToken: token, attention: sink() });
    expect(v).toEqual({ ok: true, boundBy: 'session:agent-topic' });
  });

  it('token-bearing positive id NOT in the set → refuse', () => {
    const auth = createConversationBindAuth(dir);
    const token = auth.mint('agent-topic', [7]);
    const v = verifyConversationBind({ bindAuth: auth, numericTopicId: 8, rawToken: token, attention: sink() });
    expect(v.ok).toBe(false);
  });

  it('token-LESS positive id → legacy fail-OPEN (ok, no boundBy)', () => {
    const auth = createConversationBindAuth(dir);
    const v = verifyConversationBind({ bindAuth: auth, numericTopicId: 7, rawToken: undefined, attention: sink() });
    expect(v).toEqual({ ok: true });
  });
});

describe('verifyConversationBind — no gate', () => {
  it('no bindAuth → ok (gate inert)', () => {
    expect(verifyConversationBind({ bindAuth: null, numericTopicId: -1, rawToken: undefined })).toEqual({ ok: true });
  });
  it('undefined topicId → ok (nothing to gate)', () => {
    const auth = createConversationBindAuth(dir);
    expect(verifyConversationBind({ bindAuth: auth, numericTopicId: undefined, rawToken: undefined })).toEqual({ ok: true });
  });
});
