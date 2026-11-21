/**
 * "Watch the session" on a conversation's page (Justin, topic 140618, 2026-11-14: the dashboard's
 * conversation page should match the app, starting with a jump to the session). The link lands on
 * the same Sessions row the Sessions page lists, and every other case says plainly what is true.
 */
// @ts-nocheck — the modules are browser-native ESM (.js), no types.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { conversationSession, sessionConversationRef } from '../../dashboard/console/conversation-session.js';
import { sessionKey } from '../../dashboard/console/sessions-model.js';

const NOW = Date.parse('2026-11-21T18:00:00Z');
const res = (sessions, pool = { selfMachineNickname: 'Mac Studio', machines: [{ machineId: 'm_aaaaaaaaaaaaaaaa', nickname: 'M5 Pro' }] }) => ({ ok: true, data: { sessions, pool } });
const local = (over = {}) => ({ tmuxSession: 'echo-topic-127504', status: 'running', conversationRef: 'telegram:127504', startedAt: '2026-11-21T15:00:00Z', ...over });

describe('conversationSession', () => {
  it('links a running local session to its Sessions row, named by machine and age', () => {
    const m = conversationSession(res([local()]), 'telegram:127504', NOW);
    expect(m.state).toBe('running');
    expect(m.label).toBe('Watch the session');
    expect(m.href).toBe(`#/work/sessions?s=${encodeURIComponent(sessionKey(local()))}`);
    expect(m.words).toBe('Running on Mac Studio, started 3 h ago.');
  });

  it('links a session on another machine with its remote key and that machine\'s name, never its id', () => {
    const s = { tmuxSession: 'echo-x', status: 'running', conversationRef: 'app:abc', remote: true, machineId: 'm_aaaaaaaaaaaaaaaa', startedAt: '2026-11-21T17:58:00Z' };
    const m = conversationSession(res([s]), 'app:abc', NOW);
    expect(m.href).toBe(`#/work/sessions?s=${encodeURIComponent('remote:m_aaaaaaaaaaaaaaaa:echo-x')}`);
    expect(m.words).toBe('Running on M5 Pro, started 2 min ago.');
    expect(m.words).not.toMatch(/m_[a-z0-9]/);
  });

  it('prefers this machine\'s session and says when it also runs elsewhere', () => {
    const r = { ...local({ tmuxSession: 'other' }), remote: true, machineId: 'm_aaaaaaaaaaaaaaaa', startedAt: '2026-11-21T17:59:00Z' };
    const m = conversationSession(res([r, local()]), 'telegram:127504', NOW);
    expect(m.href).toBe(`#/work/sessions?s=${encodeURIComponent('echo-topic-127504')}`);
    expect(m.words).toMatch(/also running on another machine/);
  });

  it('matches an older session row by its Telegram topic when it has no conversation ref', () => {
    const s = { tmuxSession: 'old', status: 'starting', platform: 'telegram', platformId: '127504' };
    expect(sessionConversationRef(s)).toBe('telegram:127504');
    expect(conversationSession(res([s]), 'telegram:127504', NOW).state).toBe('running');
  });

  it('says plainly when nothing is running, ignoring stopped sessions and other conversations', () => {
    const m = conversationSession(res([local({ status: 'stopped' }), local({ conversationRef: 'telegram:1' })]), 'telegram:127504', NOW);
    expect(m.state).toBe('none');
    expect(m.href).toBeUndefined();
    expect(m.words).toBe('No session is running for this conversation right now. The next message in it starts one.');
  });

  it('says it could not check when the session list fails, and shows nothing for a conversation without sessions here', () => {
    expect(conversationSession({ ok: false }, 'telegram:127504', NOW).state).toBe('unknown');
    expect(conversationSession(res([local()]), null, NOW)).toBeNull();
  });
});

describe('conversation page wiring', () => {
  it('the conversation page reads the pool session list and renders the line', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../dashboard/console/conversations.js'), 'utf8');
    expect(src).toMatch(/import \{ conversationSession \} from '\.\/conversation-session\.js'/);
    expect(src).toMatch(/read\('\/sessions\?scope=pool'/);
    expect(src).toMatch(/conversationSession\(res, liveKey\)/);
  });
});
