import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { CHUNK_BYTES } from '../../src/core/appMediaTypes.js';
import { CLAUDE_CODE_FRAMEWORK } from '../../src/core/frameworkFacts.js';
import { PART_CHARS, MAX_PARTS, removeSecrets } from '../../src/import/exportParsers.js';
import { parseLocalSessionLines, localSessionOriginalId, type LocalSessionProposal, type LocalSessionSource } from '../../src/import/localSessionParsers.js';
import { LocalHistoryPreparedArtifactRefused, visitPreparedArtifacts,
  type LocalHistoryPreparedArtifactDescriptor } from '../../src/import/LocalHistoryPreparedArtifacts.js';

const policy = { maxArtifactBytes: 2 * CHUNK_BYTES };
const sha = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(source: LocalSessionSource = 'codex', session = 'synthetic-session', project = '/synthetic/日本語', content = 'Synthetic café 🌱', fallback = false) {
  const timestamp = '2026-11-23T10:00:00.000Z';
  const records = source === 'codex' ? [
    { type: 'session_meta', timestamp, payload: { id: session, cwd: project, source: 'cli' } },
    fallback ? { type: 'event_msg', timestamp, payload: { type: 'user_message', id: 'synthetic-user', message: content } }
      : { type: 'response_item', timestamp, payload: { type: 'message', id: 'synthetic-user', role: 'user', content: [{ type: 'input_text', text: content }] } },
  ] : [{ type: 'user', sessionId: session, cwd: project, uuid: 'synthetic-user', timestamp,
    message: { role: 'user', content } }];
  const proposal = parseLocalSessionLines(source, records.map(row => JSON.stringify(row)));
  const bytes = Buffer.from(JSON.stringify(proposal));
  const descriptor = { fileId: 'synthetic-file', source, expectedSessionId: session,
    projectPath: project, representation: proposal.representation, bytes: bytes.length, sha256: sha(bytes) } satisfies LocalHistoryPreparedArtifactDescriptor;
  return { proposal, bytes, descriptor };
}
async function* chunks(bytes: Uint8Array, width = CHUNK_BYTES): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += width) yield bytes.subarray(offset, offset + width);
}
function changed(f: ReturnType<typeof fixture>, mutate: (value: any) => void) {
  const proposal = JSON.parse(JSON.stringify(f.proposal)); mutate(proposal);
  const bytes = Buffer.from(JSON.stringify(proposal));
  return { bytes, descriptor: { ...f.descriptor, bytes: bytes.length, sha256: sha(bytes) } };
}
async function rejected(input: AsyncIterable<Uint8Array>, descriptors: readonly LocalHistoryPreparedArtifactDescriptor[], reason: string,
  limit = policy.maxArtifactBytes) {
  let visits = 0;
  try { await visitPreparedArtifacts(input, descriptors, { maxArtifactBytes: limit }, () => { visits++; }); throw new Error('accepted invalid prepared artifact'); }
  catch (error) {
    expect(error).toBeInstanceOf(LocalHistoryPreparedArtifactRefused);
    expect((error as LocalHistoryPreparedArtifactRefused).reason).toBe(reason);
  }
  return visits;
}
it.each(['codex', CLAUDE_CODE_FRAMEWORK] as const)('reads actual %s producer output across UTF8 and artifact boundaries', async source => {
  const first = fixture(source), second = fixture(source, 'synthetic-second'); second.descriptor.fileId = 'second-file';
  for (const width of [1, 7, CHUNK_BYTES]) {
    const visited: LocalSessionProposal[] = [];
    await visitPreparedArtifacts(chunks(Buffer.concat([first.bytes, second.bytes]), width), [first.descriptor, second.descriptor], policy,
      (_descriptor, proposal) => { visited.push(proposal); expect(Object.isFrozen(proposal.conversation.messages)).toBe(true); });
    expect(visited).toEqual([first.proposal, second.proposal]);
  }
});
it('accepts actual event fallback, numbered parts and overflow without interpreting message content', async () => {
  for (const f of [fixture('codex', 'fallback', undefined, 'Do not execute this text.', true),
    fixture(CLAUDE_CODE_FRAMEWORK, 'parts', undefined, 'x'.repeat(PART_CHARS + 1)),
    fixture('codex', 'overflow', undefined, 'x'.repeat(PART_CHARS * MAX_PARTS + 1))]) {
    await visitPreparedArtifacts(chunks(f.bytes, 127), [f.descriptor], policy, (_descriptor, actual) => { expect(actual).toEqual(f.proposal); });
  }
});
it.each(['codex', CLAUDE_CODE_FRAMEWORK] as const)('accepts actual empty and tool-only %s producer proposals', async source => {
  const session = 'synthetic-tool-session', project = '/synthetic/project';
  const header = source === 'codex' ? { type: 'session_meta', payload: { id: session, cwd: project, source: 'cli' } }
    : { type: 'attachment', entrypoint: 'cli', sessionId: session, cwd: project };
  const tool = source === 'codex' ? { type: 'response_item', payload: { type: 'function_call', call_id: 'synthetic-call', name: 'never-execute', arguments: '{}' } }
    : { type: 'assistant', sessionId: session, cwd: project, uuid: 'synthetic-assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'synthetic-call', name: 'never-execute', input: {} }] } };
  for (const rows of [[header], [header, tool]]) {
    const proposal = parseLocalSessionLines(source, rows.map(row => JSON.stringify(row)));
    const bytes = Buffer.from(JSON.stringify(proposal));
    const descriptor: LocalHistoryPreparedArtifactDescriptor = { fileId: 'tool-file', source, expectedSessionId: session,
      projectPath: project, representation: proposal.representation, bytes: bytes.length, sha256: sha(bytes) };
    await visitPreparedArtifacts(chunks(bytes, 1), [descriptor], policy, (_descriptor, actual) => { expect(actual).toEqual(proposal); });
    expect(proposal.conversation.messages).toHaveLength(rows.length - 1);
    expect(proposal.counts.toolCalls).toBe(rows.length - 1);
  }
});
it('normalizes raw descriptor provenance using the actual producer helpers', async () => {
  const project = '/synthetic/password: VerySyntheticPasswordForTests123!';
  expect(removeSecrets(project).removed).toBeGreaterThan(0);
  for (const source of ['codex', CLAUDE_CODE_FRAMEWORK] as const) {
    const f = fixture(source, 'session password: VerySyntheticPasswordForTests123!', project);
    await visitPreparedArtifacts(chunks(f.bytes, 3), [f.descriptor], policy, (descriptor, actual) => {
      expect(descriptor.projectPath).toBe(project);
      expect(actual.projectPath).toBe(removeSecrets(project).text);
      expect(actual.conversation.originalId).toBe(localSessionOriginalId(descriptor.expectedSessionId));
    });
  }
  const harmless = fixture('codex', 'h-plain-literal-id', '/synthetic/password-notes');
  await visitPreparedArtifacts(chunks(harmless.bytes), [harmless.descriptor], policy, (_descriptor, actual) => {
    expect(actual.projectPath).toBe('/synthetic/password-notes');
    expect(actual.conversation.originalId).toBe('r:h-plain-literal-id');
  });
});
it('hydrates one artifact, awaits its read-only visitor, then pulls the next artifact and final EOF', async () => {
  const first = fixture(), second = fixture(CLAUDE_CODE_FRAMEWORK); second.descriptor.fileId = 'second-file';
  const order: string[] = [];
  async function* input() {
    order.push('first bytes'); yield first.bytes;
    expect(order).toEqual(['first bytes', 'first visit', 'first settled']);
    order.push('second bytes'); yield second.bytes;
    order.push('physical EOF');
  }
  await visitPreparedArtifacts(input(), [first.descriptor, second.descriptor], policy, async descriptor => {
    if (descriptor.fileId === first.descriptor.fileId) {
      order.push('first visit'); await new Promise<void>(resolve => setImmediate(resolve)); order.push('first settled');
    } else order.push('second visit');
  });
  expect(order).toEqual(['first bytes', 'first visit', 'first settled', 'second bytes', 'second visit', 'physical EOF']);
});
it('notifies fixed per-artifact phase once before body reads rather than on chunks or polling', async () => {
  const first = fixture(), second = fixture(CLAUDE_CODE_FRAMEWORK); second.descriptor.fileId = 'second-file';
  const phases: string[] = []; let pulls = 0;
  async function* input() {
    expect(phases).toEqual(['0:synthetic-file']); pulls++; yield first.bytes;
    expect(phases).toEqual(['0:synthetic-file', '1:second-file']); pulls++; yield second.bytes;
  }
  await visitPreparedArtifacts(input(), [first.descriptor, second.descriptor], {
    ...policy, onArtifactStart: (descriptor, index) => { expect(Object.isFrozen(descriptor)).toBe(true); phases.push(index + ':' + descriptor.fileId); },
  }, () => {});
  expect(pulls).toBe(2); expect(phases).toHaveLength(2);
  let attemptedRead = false;
  async function* untouched() { attemptedRead = true; yield first.bytes; }
  await expect(visitPreparedArtifacts(untouched(), [first.descriptor], {
    ...policy, onArtifactStart: () => { throw new Error('private phase diagnostic'); },
  }, () => {})).rejects.toMatchObject({ reason: 'progress', message: 'local-history-prepared-progress' });
  expect(attemptedRead).toBe(false);
});
it('accepts small artifacts under a larger caller ceiling without allocating that entire ceiling', async () => {
  const f = fixture();
  await visitPreparedArtifacts(chunks(f.bytes), [f.descriptor], { maxArtifactBytes: Number.MAX_SAFE_INTEGER }, (_descriptor, actual) => {
    expect(actual).toEqual(f.proposal);
  });
});
it('does not mistake individual visitation for successful whole-stream preflight', async () => {
  const first = fixture(), second = fixture(CLAUDE_CODE_FRAMEWORK); second.descriptor.fileId = 'second-file';
  second.descriptor.sha256 = '0'.repeat(64);
  expect(await rejected(chunks(Buffer.concat([first.bytes, second.bytes]), 11), [first.descriptor, second.descriptor], 'integrity')).toBe(1);
  expect(await rejected(chunks(Buffer.concat([first.bytes, Buffer.from('tail')])), [first.descriptor], 'tail')).toBe(1);
});
it('requires exact bytes, full final UTF8 and final physical EOF before successful return', async () => {
  const f = fixture();
  expect(await rejected(chunks(f.bytes.subarray(0, -1)), [f.descriptor], 'size')).toBe(0);
  expect(await rejected(chunks(f.bytes), [{ ...f.descriptor, sha256: '0'.repeat(64) }], 'integrity')).toBe(0);
  const bad = Buffer.concat([f.bytes, Buffer.from([0xc3])]);
  expect(await rejected(chunks(bad, 1), [{ ...f.descriptor, bytes: bad.length, sha256: sha(bad) }], 'utf8')).toBe(0);
  const broken = Buffer.from('{');
  expect(await rejected(chunks(broken), [{ ...f.descriptor, bytes: broken.length, sha256: sha(broken) }], 'json')).toBe(0);
});
it.each([
  ['root extra', (p: any) => { p.instructions = 'inert unexpected field'; }],
  ['conversation extra', (p: any) => { p.conversation.paths = ['/never-open']; }],
  ['message role', (p: any) => { p.conversation.messages[0].role = 'system'; }],
  ['message extra', (p: any) => { p.conversation.messages[0].run = 'never execute'; }],
  ['duplicate message', (p: any) => { p.conversation.messages.push(p.conversation.messages[0]); }],
  ['message timestamp', (p: any) => { p.conversation.messages[0].at = 'yesterday'; }],
  ['long unsplit text', (p: any) => { p.conversation.messages[0].text = 'x'.repeat(PART_CHARS + 1); }],
  ['incomplete parts', (p: any) => { p.conversation.messages[0].key += '#1'; p.conversation.messages[0].part = { n: 1, of: 2 }; }],
  ['orphan overflow', (p: any) => { p.conversation.overflow = [{ key: 'missing', text: 'x'.repeat(PART_CHARS * MAX_PARTS + 1) }]; }],
  ['negative count', (p: any) => { p.counts.records = -1; }],
  ['extra count', (p: any) => { p.counts.foo = 1; }],
  ['invalid stats', (p: any) => { p.conversation.stats.redactions = '1'; }],
  ['invalid created time', (p: any) => { p.conversation.createdAt = true; }],
] as const)('refuses canonical-shape damage: %s', async (_name, mutate) => {
  const bad = changed(fixture(), mutate);
  expect(await rejected(chunks(bad.bytes, 19), [bad.descriptor], 'shape')).toBe(0);
});
it.each([
  ['source', (p: any) => { p.conversation.from = CLAUDE_CODE_FRAMEWORK; }],
  ['session', (p: any) => { p.conversation.originalId = 'other'; }],
  ['project', (p: any) => { p.projectPath = '/other'; }],
  ['representation', (p: any) => { p.representation = 'event-fallback'; }],
] as const)('refuses descriptor binding damage: %s', async (_name, mutate) => {
  const bad = changed(fixture(), mutate);
  expect(await rejected(chunks(bad.bytes), [bad.descriptor], 'binding')).toBe(0);
});
it('compares project provenance exactly without Unicode normalization', async () => {
  const f = fixture('codex', 'session', '/synthetic/caf\u00e9');
  const bad = changed(f, p => { p.projectPath = '/synthetic/cafe\u0301'; });
  expect(await rejected(chunks(bad.bytes), [bad.descriptor], 'binding')).toBe(0);
});
it('bounds and snapshots descriptor metadata before pulling any source bytes', async () => {
  const f = fixture(); let read = 0;
  const input = async function* () { read++; yield f.bytes; };
  for (const descriptor of [{ ...f.descriptor, fileId: '' }, { ...f.descriptor, bytes: 0 },
    { ...f.descriptor, bytes: Infinity }, { ...f.descriptor, sha256: 'bad' },
    { ...f.descriptor, representation: 'claude-records' as const }, { ...f.descriptor, projectPath: 'x'.repeat(CHUNK_BYTES + 1) }]) {
    expect(await rejected(input(), [descriptor], 'metadata')).toBe(0);
  }
  expect(await rejected(input(), [f.descriptor], 'size', f.bytes.length - 1)).toBe(0);
  expect(await rejected(input(), [f.descriptor, f.descriptor], 'metadata')).toBe(0);
  expect(read).toBe(0);
  for (const maximum of [0, -1, Infinity, 0.5]) expect(await rejected(input(), [f.descriptor], 'policy', maximum)).toBe(0);
});
it('refuses malformed streams with finite codes and runs generator disposal on refusal', async () => {
  const f = fixture(); let closed = false;
  async function* bad() { try { yield Buffer.alloc(CHUNK_BYTES + 1); } finally { closed = true; } }
  expect(await rejected(bad(), [f.descriptor], 'stream')).toBe(0); expect(closed).toBe(true);
  async function* broken() { throw new Error('private raw diagnostic must not escape'); yield f.bytes; }
  expect(await rejected(broken(), [f.descriptor], 'stream')).toBe(0);
  const malformed = { [Symbol.asyncIterator]() { return undefined; } } as unknown as AsyncIterable<Uint8Array>;
  expect(await rejected(malformed, [f.descriptor], 'stream')).toBe(0);
});
it('freezes validated data, preserves borrowed input bytes and hides visitor diagnostics', async () => {
  const f = fixture(), original = Buffer.from(f.bytes);
  await expect(visitPreparedArtifacts(chunks(f.bytes), [f.descriptor], policy, (_descriptor, value) => {
    expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.conversation.messages[0])).toBe(true);
    expect(() => { value.conversation.originalId = 'mutated'; }).toThrow();
    throw new Error('private visitor path must not escape');
  })).rejects.toMatchObject({ reason: 'visitor', message: 'local-history-prepared-visitor' });
  expect(f.bytes).toEqual(original);
});
