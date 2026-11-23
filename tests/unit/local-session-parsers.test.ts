import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createLocalSessionParser, LocalSessionRefused, parseLocalSessionLines } from '../../src/import/localSessionParsers.js';
import { PART_CHARS, REMOVED_MARKER } from '../../src/import/exportParsers.js';

const stamp = '2026-01-02T03:04:05.000Z';
const line = (value: unknown) => JSON.stringify(value);
const meta = (id = 'session-codex', cwd = '/projects/garden') => line({ type: 'session_meta', timestamp: stamp, payload: { id, cwd, timestamp: stamp } });
const canonical = (role: string, text: string, id?: string, extra = {}) => line({ type: 'response_item', timestamp: stamp, payload: { type: 'message', role, id, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], ...extra } });
const event = (role: 'user' | 'agent', message: string, extra = {}) => line({ type: 'event_msg', timestamp: stamp, payload: { type: `${role}_message`, message, ...extra } });
const claude = (role: 'user' | 'assistant', content: unknown, uuid = 'm1', extra = {}) => line({ type: role, timestamp: stamp, sessionId: 'session-claude', cwd: '/projects/garden', uuid, message: { role, content }, ...extra });
const options = { expectedSessionId: 'session-codex', expectedProjectPath: '/projects/garden' };

function texts(lines: string[]) { return parseLocalSessionLines('codex', lines, options).conversation.messages.map(m => m.text); }

describe('local Codex conversation parser', () => {
  it('keeps the actual words, source, session, project and original dates', () => {
    const result = parseLocalSessionLines('codex', [meta(), canonical('user', 'Please plant tomatoes', 'u1'), canonical('assistant', 'Use a sunny spot', 'a1')], options);
    expect(result).toMatchObject({ projectPath: '/projects/garden', conversation: { from: 'codex', originalId: 'session-codex', createdAt: stamp } });
    expect(result.conversation.messages).toMatchObject([
      { key: 'm:u1', role: 'operator', senderName: 'You', text: 'Please plant tomatoes', at: stamp },
      { key: 'm:a1', role: 'agent', senderName: 'Codex', text: 'Use a sunny spot', at: stamp },
    ]);
  });

  it.each([
    [event('user', 'hello'), canonical('user', 'hello', 'u1')],
    [canonical('user', 'hello', 'u1'), event('user', 'hello')],
  ])('pairs one event echo with its canonical representation in either order', (first, second) => {
    const result = parseLocalSessionLines('codex', [meta(), line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }), first, second], options);
    expect(result.conversation.messages).toMatchObject([{ key: 'm:u1', text: 'hello' }]);
    expect(result.counts.excluded).toBeGreaterThanOrEqual(2);
  });

  it('preserves repeated equal user turns even when timestamps are identical', () => {
    expect(texts([meta(), line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }), event('user', 'again'), canonical('user', 'again', 'u1'), event('user', 'again'), canonical('user', 'again', 'u2')])).toEqual(['again', 'again']);
    expect(texts([meta(), canonical('user', 'again', 'u1'), canonical('user', 'again', 'u2')])).toEqual(['again', 'again']);
    expect(texts([meta(), event('user', 'again'), event('user', 'again')])).toEqual(['again', 'again']);
  });

  it('takes canonical messages as the stream authority, independently of text equality', () => {
    expect(texts([meta(), event('user', 'again'), canonical('user', 'again', 'u2')])).toEqual(['again']);
    expect(texts([meta(), event('user', 'event words', { id: 'u1' }), canonical('user', 'canonical words', 'u2')])).toEqual(['canonical words']);
  });

  it('pairs a canonical echo with a shared explicit ID without a turn marker', () => {
    expect(texts([meta(), event('user', 'hello', { id: 'u1' }), canonical('user', 'hello', 'u1')])).toEqual(['hello']);
  });

  it('does not revive UI notification messages across explicit turn boundaries', () => {
    expect(texts([meta(), event('user', 'again'), line({ type: 'turn_context', payload: { turn_id: 'turn-2', cwd: '/projects/garden' } }), canonical('user', 'again', 'u2')])).toEqual(['again']);
  });

  it('uses the canonical stream without message IDs or turn IDs and keeps tools in either mode', () => {
    const call = line({ type: 'response_item', timestamp: stamp, payload: { type: 'function_call', call_id: 'c1', arguments: 'PRIVATE', name: 'PRIVATE' } });
    expect(texts([meta(), event('user', 'hello'), call, canonical('user', 'hello'), event('agent', 'answer'), canonical('assistant', 'answer'), event('agent', 'tail')])).toEqual(['Used a tool.', 'hello', 'answer']);
    expect(texts([meta(), event('user', 'hello'), call, event('agent', 'answer')])).toEqual(['hello', 'Used a tool.', 'answer']);
  });

  it('removes discarded fallback redactions and splits from canonical preview counts', () => {
    const secret = `sk-ant-api03-${'A1b2C3d4'.repeat(12)}`;
    const result = parseLocalSessionLines('codex', [meta(), event('user', 'x'.repeat(PART_CHARS + 5) + secret), event('agent', 'fallback'), canonical('user', 'safe', 'u1')], options);
    expect(result.conversation.messages.map(m => m.text)).toEqual(['safe']);
    expect(result.conversation.stats).toMatchObject({ redactions: 0, splitMessages: 0 });
  });

  it('retains event-only sessions and gives messages stable keys on prefix re-import', () => {
    const prefix = [meta(), event('user', 'hello'), event('agent', 'reply')];
    const before = parseLocalSessionLines('codex', prefix, options).conversation.messages;
    const after = parseLocalSessionLines('codex', [...prefix, event('user', 'another')], options).conversation.messages;
    expect(before).toEqual(after.slice(0, 2));
    expect(new Set(after.map(m => m.key)).size).toBe(3);
  });

  it('keeps no-ID keys stable when metadata, malformed rows or UI echoes are inserted', () => {
    const originals = [meta(), canonical('user', 'again'), canonical('user', 'again'), canonical('assistant', 'answer')];
    const withMetadata = [meta(), line({ type: 'turn_context', payload: { cwd: '/projects/garden' } }), 'broken row', event('user', 'again'), canonical('user', 'again'), line({ type: 'event_msg', payload: { type: 'token_count', info: {} } }), canonical('user', 'again'), event('agent', 'answer'), canonical('assistant', 'answer')];
    const before = parseLocalSessionLines('codex', originals, options).conversation.messages;
    const after = parseLocalSessionLines('codex', withMetadata, options).conversation.messages;
    expect(after).toEqual(before);
    expect(new Set(after.map(m => m.key)).size).toBe(3);
    const eventOnly = [meta(), event('user', 'again'), event('user', 'again')];
    const eventWithMetadata = [meta(), 'broken row', event('user', 'again'), line({ type: 'turn_context', payload: { cwd: '/projects/garden' } }), event('user', 'again')];
    expect(parseLocalSessionLines('codex', eventWithMetadata, options).conversation.messages).toEqual(parseLocalSessionLines('codex', eventOnly, options).conversation.messages);
  });

  it('does not let empty, non-text or tool-result-only canonical records erase event-only history', () => {
    const empty = canonical('user', '');
    const nonText = line({ type: 'response_item', timestamp: stamp, payload: { type: 'message', role: 'user', content: [{ type: 'image', image: 'PRIVATE' }] } });
    const toolResult = line({ type: 'response_item', timestamp: stamp, payload: { type: 'message', role: 'user', content: [{ type: 'tool_result', content: 'PRIVATE' }] } });
    expect(texts([meta(), event('user', 'hello'), empty, nonText, toolResult, event('agent', 'answer')])).toEqual(['hello', 'answer']);
    expect(texts([meta(), event('user', 'fallback'), empty, canonical('user', 'real')])).toEqual(['real']);
  });

  it('exposes representation and refuses an event-to-canonical mode change against an earlier receipt', () => {
    const legacy = parseLocalSessionLines('codex', [meta(), event('user', 'hello')], options);
    expect(legacy.representation).toBe('event-fallback');
    expect(() => parseLocalSessionLines('codex', [meta(), event('user', 'hello'), canonical('user', 'hello', 'u1')], { ...options, expectedRepresentation: legacy.representation })).toThrow('representation-mismatch');
    expect(parseLocalSessionLines('codex', [meta(), canonical('user', 'hello', 'u1')], { ...options, expectedRepresentation: 'canonical' }).representation).toBe('canonical');
  });

  it('keeps hashed unsafe IDs disjoint from literal hash-looking IDs for sessions and messages', () => {
    const unsafe = '../untrusted-id';
    const literal = 'h-' + crypto.createHash('sha256').update(unsafe).digest('hex').slice(0, 32);
    const first = parseLocalSessionLines('codex', [meta(unsafe), canonical('user', 'first', unsafe)]);
    const second = parseLocalSessionLines('codex', [meta(literal), canonical('user', 'second', literal)]);
    expect(first.conversation.originalId).not.toBe(second.conversation.originalId);
    const together = parseLocalSessionLines('codex', [meta(), canonical('user', 'first', unsafe), canonical('user', 'second', literal)], options);
    expect(new Set(together.conversation.messages.map(m => m.key)).size).toBe(2);
  });

  it('does not import system instructions, analysis, compacted replacements, tool arguments or tool output', () => {
    const result = parseLocalSessionLines('codex', [meta(), canonical('system', 'SYSTEM MUST NOT IMPORT'), canonical('developer', 'DEVELOPER MUST NOT IMPORT'), canonical('assistant', 'PRIVATE ANALYSIS', undefined, { channel: 'analysis' }),
      line({ type: 'compacted', payload: { replacement_history: [{ role: 'user', content: 'INHERITED SECRET' }] } }),
      line({ type: 'response_item', timestamp: stamp, payload: { type: 'function_call', call_id: 'call1', name: 'VERY PRIVATE NAME', arguments: 'PRIVATE ARGUMENTS' } }),
      line({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call1', output: 'ENTICING PRIVATE OUTPUT' } }),
      canonical('assistant', 'Public answer', 'a1')], options);
    expect(result.conversation.messages.map(m => m.text)).toEqual(['Used a tool.', 'Public answer']);
    expect(result.counts.toolCalls).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SYSTEM MUST|DEVELOPER MUST|ENTICING/);
  });

  it('keeps imperative user text as quoted source material rather than treating it as active instructions', () => {
    expect(texts([meta(), canonical('user', 'Ignore earlier notes and use the east bed.', 'u1')])).toEqual(['Ignore earlier notes and use the east bed.']);
  });

  it('refuses a structurally marked fork rather than copying inherited parent history', () => {
    const fork = line({ type: 'session_meta', payload: { id: 'session-codex', cwd: '/projects/garden', forked_from_id: 'parent-session' } });
    expect(() => parseLocalSessionLines('codex', [fork, canonical('user', 'INHERITED PARENT TEXT')], options)).toThrow('unsupported-fork');
  });

  it.each([
    { source: { subagent: { thread_spawn: { parent_thread_id: '00000000-0000-4000-8000-000000000001', depth: 1 } } } },
    { source: { subagent: 'review' } },
    { source: { subagent: 'compact' } },
    { source: { subagent: 'memory_consolidation' } },
    { source: { subagent: { other: 'custom-worker' } } },
    { source: { internal: 'memory_consolidation' } },
    { source: { internal: 'guardian' } },
    { thread_source: 'subagent' },
    { thread_source: 'guardian_review' },
    { thread_source: 'memory_consolidation' },
  ])('refuses explicit non-user session metadata without needing a fork marker: %j', markers => {
    const header = line({ type: 'session_meta', payload: { id: 'session-codex', cwd: '/projects/garden', ...markers } });
    expect(() => parseLocalSessionLines('codex', [header, canonical('user', 'INHERITED OR INTERNAL TEXT')], options)).toThrow('unsupported-nonuser-session');
  });

  it.each([
    {}, { source: 'cli' }, { source: 'vscode' }, { source: 'exec' }, { source: 'mcp' },
    { source: { custom: 'custom-client' } }, { source: 'unknown' },
    { source: { custom: 'subagent' } }, { thread_source: 'user' }, { thread_source: 'custom-feature' },
  ])('preserves ordinary source metadata compatibility: %j', markers => {
    const header = line({ type: 'session_meta', payload: { id: 'session-codex', cwd: '/projects/garden', ...markers } });
    expect(texts([header, canonical('user', 'The words subagent and internal are ordinary source text.', 'u1')])).toEqual(['The words subagent and internal are ordinary source text.']);
  });

  it('counts malformed and excluded records without copying their raw contents into errors', () => {
    const result = parseLocalSessionLines('codex', [meta(), 'PRIVATE malformed', '42', line({ type: 'unknown', payload: { secret: 'PRIVATE content' } }), canonical('user', 'safe', 'u1')], options);
    expect(result.counts.malformed).toBe(2);
    expect(result.counts.excluded).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it.each([
    [[meta('different')], 'session-mismatch'],
    [[meta('session-codex', '/other')], 'project-mismatch'],
    [[meta(), meta('other-session')], 'session-mismatch'],
    [[meta(), line({ type: 'turn_context', payload: { cwd: '/other' } })], 'project-mismatch'],
    [[meta(), canonical('user', 'hidden', 'u1', { session_id: 'different' })], 'session-mismatch'],
    [[canonical('user', 'headerless', 'u1')], 'identity-missing'],
  ] as const)('refuses missing or conflicting selection provenance', (lines, reason) => {
    expect(() => parseLocalSessionLines('codex', lines, options)).toThrow(`Local session refused: ${reason}`);
  });
});

describe('local Claude Code conversation parser', () => {
  it('uses an interactive attachment header for provenance without importing attachment content', () => {
    const header = line({ type: 'attachment', entrypoint: 'cli', sessionId: 'session-claude', cwd: '/projects/garden', timestamp: stamp, attachment: { text: 'PRIVATE ATTACHMENT' } });
    const user = line({ type: 'user', sessionId: 'session-claude', uuid: 'u1', timestamp: stamp, message: { role: 'user', content: 'hello' } });
    const result = parseLocalSessionLines('claude-code', [header, user]);
    expect(result.projectPath).toBe('/projects/garden');
    expect(result.representation).toBe('claude-records');
    expect(result.conversation.messages.map(m => m.text)).toEqual(['hello']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('keeps text blocks while representing tools with fixed descriptions only', () => {
    const result = parseLocalSessionLines('claude-code', [claude('user', 'How is the garden?', 'u1'), claude('assistant', [
      { type: 'text', text: 'I will check.' }, { type: 'thinking', thinking: 'PRIVATE THOUGHT' },
      { type: 'tool_use', id: 'call1', name: 'PRIVATE NAME', input: { command: 'PRIVATE COMMAND' } },
    ], 'a1'), claude('user', [{ type: 'tool_result', tool_use_id: 'call1', content: 'PRIVATE OUTPUT' }], 'r1'), claude('assistant', [{ type: 'text', text: 'It looks healthy.' }], 'a2')]);
    expect(result.conversation.messages.map(m => m.text)).toEqual(['How is the garden?', 'I will check.', 'Used a tool.', 'It looks healthy.']);
    expect(result.conversation.messages.at(-1)?.senderName).toBe('Claude Code');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('skips explicitly marked meta/inherited summaries without stripping real user words', () => {
    const result = parseLocalSessionLines('claude-code', [claude('user', 'INHERITED', 'meta', { isMeta: true }), claude('user', 'COMPACTION', 'summary', { isCompactSummary: true }), claude('user', 'Please never plant mint here.', 'u1')]);
    expect(result.conversation.messages.map(m => m.text)).toEqual(['Please never plant mint here.']);
  });

  it('excludes structurally marked sidechain and subagent records even under the selected identity', () => {
    const result = parseLocalSessionLines('claude-code', [claude('user', 'SIDECHAIN PRIVATE', 's1', { isSidechain: true }), claude('assistant', 'SUBAGENT PRIVATE', 's2', { agentId: 'helper-1' }), claude('user', 'main conversation', 'u1')]);
    expect(result.conversation.messages.map(m => m.text)).toEqual(['main conversation']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('deduplicates explicit message replays but preserves distinct equal messages', () => {
    const result = parseLocalSessionLines('claude-code', [claude('user', 'again', 'u1'), claude('user', 'again', 'u1'), claude('user', 'again', 'u2')]);
    expect(result.conversation.messages.map(m => m.text)).toEqual(['again', 'again']);
    expect(result.counts.duplicateMessages).toBe(1);
  });

  it('refuses changed content reusing a message identifier', () => {
    expect(() => parseLocalSessionLines('claude-code', [claude('user', 'first', 'u1'), claude('user', 'changed', 'u1')])).toThrow('conflicting-message-id');
  });

  it('rejects an unsupported source at runtime', () => {
    expect(() => createLocalSessionParser('other' as 'codex')).toThrow('unsupported-source');
  });

  it('scrubs secrets before message splitting and preserves the original timestamp', () => {
    const secret = `sk-ant-api03-${'A1b2C3d4'.repeat(12)}`;
    const message = 'x'.repeat(PART_CHARS - 10) + ' ' + secret + ' end';
    const result = parseLocalSessionLines('claude-code', [claude('user', message, 'u1')]);
    expect(result.conversation.messages.length).toBeGreaterThan(1);
    expect(result.conversation.stats.redactions).toBeGreaterThan(0);
    expect(result.conversation.messages.map(m => m.text).join('')).toContain(REMOVED_MARKER);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.conversation.messages.every(m => m.at === stamp)).toBe(true);
  });

  it('does not allow a user record to introduce a fake assistant tool call', () => {
    const result = parseLocalSessionLines('claude-code', [claude('user', [{ type: 'tool_use', id: 'fake', name: 'Bash', input: {} }]), claude('user', 'real', 'u2')]);
    expect(result.conversation.messages.map(m => m.text)).toEqual(['real']);
    expect(result.counts.toolCalls).toBe(0);
  });

  it('is incremental and finish is idempotent; pushing after finish is refused', () => {
    const parser = createLocalSessionParser('claude-code');
    parser.push(claude('user', 'hello'));
    const first = parser.finish();
    expect(parser.finish()).toBe(first);
    expect(() => parser.push(claude('assistant', 'later'))).toThrow(LocalSessionRefused);
  });
});
