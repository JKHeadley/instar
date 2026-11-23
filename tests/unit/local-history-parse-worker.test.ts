import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

const workerPath = fileURLToPath(new URL('../../dist/import/localHistoryParseWorker.js', import.meta.url));
function frame(source: Buffer, overrides: Record<string, unknown> = {}): Buffer {
  const header = Buffer.from(JSON.stringify({ source: 'codex', expectedSessionId: 'session-1',
    expectedProjectPath: '/synthetic/project', bytes: source.length,
    sha256: crypto.createHash('sha256').update(source).digest('hex'), ...overrides }));
  const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
  return Buffer.concat([length, header, source]);
}
function transcript(text = 'Only synthetic conversation text.'): Buffer {
  return Buffer.from([
    { type: 'session_meta', payload: { id: 'session-1', cwd: '/synthetic/project', source: 'cli' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
  ].map(value => JSON.stringify(value)).join('\n'));
}
async function run(input: Buffer) {
  const child = fork(workerPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    execArgv: ['--max-old-space-size=128'], env: { LANG: 'C.UTF-8', TZ: 'UTC' } });
  const output: Buffer[] = []; const errors: Buffer[] = []; const control: unknown[] = [];
  child.stdout!.on('data', value => output.push(value));
  child.stderr!.on('data', value => errors.push(value));
  child.on('message', value => control.push(value));
  // Invalid frames may make the real child close stdin before the test write completes.
  child.stdin!.on('error', () => {});
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  child.stdin!.end(input);
  try { return { code: await done, output: Buffer.concat(output), errors: Buffer.concat(errors).toString(), control }; }
  finally { clearTimeout(timeout); }
}

describe('real local history parse child', () => {
  it('parses private stdin and emits a complete hash-bound artifact with metadata-only control', async () => {
    const text = 'synthetic '.repeat(8000) + '👋';
    const result = await run(frame(transcript(text)));
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.output.toString());
    expect(parsed.conversation.messages.map((message: {text: string}) => message.text).join('')).toBe(text);
    expect(result.errors).toBe('');
    expect(result.control).toContainEqual(expect.objectContaining({ kind: 'complete', bytes: result.output.length,
      sha256: crypto.createHash('sha256').update(result.output).digest('hex') }));
    expect(JSON.stringify(result.control)).not.toContain('synthetic');
  });
  it.each([
    { expectedSessionId: 'wrong' }, { expectedProjectPath: '/wrong' },
    { sha256: '0'.repeat(64) }, { bytes: 1 }, { source: 'chatgpt' }, { expectedRepresentation: 'event-fallback' },
  ])('refuses mismatched committed input without publishing private output %j', async overrides => {
    const result = await run(frame(transcript(), overrides));
    expect(result.code).toBe(65); expect(result.output.length).toBe(0); expect(result.errors).toBe('');
    expect(JSON.stringify(result.control)).not.toContain('synthetic');
  });
  it('rejects invalid UTF-8 and truncated framing with no raw diagnostics', async () => {
    for (const input of [frame(Buffer.from([0xff, 0xfe])), Buffer.from([0, 0, 0, 20, 0x7b])]) {
      const result = await run(input);
      expect(result.code).toBe(65); expect(result.output.length).toBe(0); expect(result.errors).toBe('');
    }
  });
  it('exits on parent IPC disconnect before another input frame', async () => {
    const child = fork(workerPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      execArgv: ['--max-old-space-size=128'], env: { LANG: 'C.UTF-8', TZ: 'UTC' } });
    const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    child.stdout!.resume(); child.stderr!.resume();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try {
      await Promise.race([once(child, 'message'), closed.then(() => { throw new Error('worker exited before ready'); })]);
      // Initialization has completed; a partial prefix cannot finish a parse.
      child.stdin!.on('error', () => {}); child.stdin!.write(Buffer.from([0]));
      child.disconnect();
      expect(await closed).toBe(71);
    } finally {
      clearTimeout(timeout); child.stdin!.destroy(); child.stdout!.destroy(); child.stderr!.destroy();
    }
  });
});
