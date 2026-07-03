/**
 * conversation-bind-token.test.ts — the §7 bind-time authority primitive
 * (durable-conversation-identity, increment 2 / B7 / R3-M5 / R4-M3).
 *
 * The load-bearing property is STATELESSNESS (R4-M3): a live tmux session
 * OUTLIVES the server process, and instar restarts on every auto-update — so a
 * token minted at spawn must remain valid across ANY number of server
 * restarts, verified by a FRESH ConversationBindAuth over the SAME secret file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createConversationBindAuth,
  ensureBindTokenSecret,
  ensureBindDeployStamp,
  bindDeployStampAgeDays,
  mintBindToken,
  verifyBindToken,
  TOKENLESS_BIND_GRACE_DAYS,
} from '../../src/core/conversationBindToken.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('conversation bind token (§7)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-bind-'));
  });
  afterEach(() => {
    try {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/conversation-bind-token.test.ts' });
    } catch {
      /* cleanup */
    }
  });

  it('mint → verify round-trips the payload (sessionName + bootstrap set)', () => {
    const auth = createConversationBindAuth(dir);
    const token = auth.mint('agent-slack-thread', [-111, -222]);
    const payload = auth.verify(token);
    expect(payload).not.toBeNull();
    expect(payload!.sessionName).toBe('agent-slack-thread');
    expect(payload!.bootstrapConversationIds).toEqual([-111, -222]);
  });

  it('a tampered payload (bootstrap set edited, MAC stale) is REFUSED', () => {
    const secret = ensureBindTokenSecret(dir);
    const token = mintBindToken(secret, { sessionName: 's', bootstrapConversationIds: [-1], mintedAt: 'now' });
    const [body] = token.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ sessionName: 's', bootstrapConversationIds: [-999], mintedAt: 'now' }), 'utf-8').toString('base64url');
    const tampered = `${forgedBody}.${token.slice(body.length + 1)}`;
    expect(verifyBindToken(secret, tampered)).toBeNull();
  });

  it('a token minted under one secret is REFUSED by a different secret (no cross-agent replay)', () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-bind2-'));
    try {
      const a1 = createConversationBindAuth(dir);
      const a2 = createConversationBindAuth(dir2);
      const token = a1.mint('s', [-1]);
      expect(a2.verify(token)).toBeNull();
    } finally {
      SafeFsExecutor.safeRmSync(dir2, { recursive: true, force: true, operation: 'test cleanup' });
    }
  });

  it('STATELESS survival: a token stays valid across a FRESH ConversationBindAuth over the same secret (server-restart proxy — R4-M3)', () => {
    const before = createConversationBindAuth(dir);
    const token = before.mint('long-lived-session', [-42]);
    // Simulate a server restart: a brand-new auth instance, same secret file.
    const after = createConversationBindAuth(dir);
    const payload = after.verify(token);
    expect(payload).not.toBeNull();
    expect(payload!.bootstrapConversationIds).toContain(-42);
  });

  it('rotating the secret (delete the file) invalidates ALL outstanding tokens (the loud revocation lever)', () => {
    const before = createConversationBindAuth(dir);
    const token = before.mint('s', [-1]);
    SafeFsExecutor.safeUnlinkSync(path.join(dir, 'state', 'conversation-bind-token.secret'), { operation: 'test — rotate secret' });
    const after = createConversationBindAuth(dir); // regenerates a fresh secret
    expect(after.verify(token)).toBeNull();
  });

  it('a malformed / non-token string is refused, never throws', () => {
    const auth = createConversationBindAuth(dir);
    for (const bad of ['', 'no-dot', '.', 'a.', '.b', 'x'.repeat(5000)]) {
      expect(auth.verify(bad)).toBeNull();
    }
  });

  it('the deploy stamp is written once (idempotent) and its age reads back', () => {
    ensureBindDeployStamp(dir, '1.3.999');
    const stampPath = path.join(dir, 'state', 'conversation-registry-deploy.json');
    const first = fs.readFileSync(stampPath, 'utf-8');
    ensureBindDeployStamp(dir, '9.9.9'); // second call is a no-op (never overwrites)
    expect(fs.readFileSync(stampPath, 'utf-8')).toBe(first);
    expect(bindDeployStampAgeDays(dir)).toBe(0);
    // An unstamped dir reads null (the backstop stays unarmed — fail-open).
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-nostamp-'));
    try {
      expect(bindDeployStampAgeDays(dir2)).toBeNull();
    } finally {
      SafeFsExecutor.safeRmSync(dir2, { recursive: true, force: true, operation: 'test cleanup' });
    }
  });

  it('the straggler grace window constant is 14 days', () => {
    expect(TOKENLESS_BIND_GRACE_DAYS).toBe(14);
  });
});
