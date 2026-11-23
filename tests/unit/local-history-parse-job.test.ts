import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { localSessionByteChunks } from '../../src/import/localSessionSnapshot.js';
import { acquireLocalHistoryChild } from '../../dist/import/LocalHistoryChildCustody.js';
import { ImportedHistoryStore } from '../../src/import/ImportedHistoryStore.js';
import { afterEach, describe, expect, it } from 'vitest';
// Exercise the exact deployed fixed-child module, not an inline substitute.
import { runLocalHistoryParseJob, type LocalHistoryParseJobOptions } from '../../dist/import/LocalHistoryParseJob.js';

const custodyDirs: string[] = [];
afterEach(() => { for (const dir of custodyDirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'parse custody test' }); });
function setup() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-custody-')); custodyDirs.push(stateDir);
  const bytes = Buffer.from([
    { type: 'session_meta', payload: { id: 's', cwd: '/synthetic', source: 'cli' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'synthetic only' }] } },
  ].map(record => JSON.stringify(record)).join('\n'));
  let authorized = true; let released = 0; let pid = 0; let registered = false; let chunksRead = 0;
  const output: Buffer[] = [];
  const opts: LocalHistoryParseJobOptions = {
    input: { source: 'codex', expectedSessionId: 's', expectedProjectPath: '/synthetic', bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') },
    async acquireChild() { const actual = acquireLocalHistoryChild(stateDir)!; return {
      custody: actual.custody,
      async registerChild(value) { await actual.registerChild(value); pid = value; registered = true; },
      release() { if (registered) expect(() => process.kill(pid, 0)).toThrow(); actual.release(); released++; },
    }; },
    authorized() { return authorized; },
    async *chunks() { expect(registered).toBe(true); chunksRead++; yield bytes; },
    async writeOutput(block) { output.push(Buffer.from(block)); },
    heapMiB: 128, deadlineMs: 10_000, rssBytes: 768 * 1024 * 1024,
  };
  return { opts, output, stateDir, setAuthorized(value: boolean) { authorized = value; }, released: () => released,
    chunksRead: () => chunksRead, childPid: () => pid };
}
describe('real bounded parse job', () => {
  it('enforces the actual owners durable source mode inside the admitted child', async () => {
    const f = setup(), store = new ImportedHistoryStore(f.stateDir);
    await store.withWriter(async () => { store.assertOrClaimLocalSource({ ownerUserId: 'synthetic-owner', source: 'codex',
      originalId: 's', projectPath: '/synthetic', representation: 'event-fallback', parserContractVersion: 1 }); });
    f.opts.input.ownerUserId = 'synthetic-owner';
    await expect(runLocalHistoryParseJob(f.opts)).rejects.toThrow('parser-refused');
    expect(f.output).toHaveLength(0); expect(f.released()).toBe(1);
    f.opts.input.expectedRepresentation = 'canonical';
    await expect(runLocalHistoryParseJob(f.opts)).rejects.toThrow('parser-refused');
    expect(f.output).toHaveLength(0); expect(f.released()).toBe(2);
    expect(store.readLocalSourceClaim({ ownerUserId: 'synthetic-owner', source: 'codex', originalId: 's' })?.representation).toBe('event-fallback');
    f.opts.input.ownerUserId = 'other-synthetic-owner';
    expect((await runLocalHistoryParseJob(f.opts)).representation).toBe('canonical');
    expect(f.released()).toBe(3);
    expect(store.readLocalSourceClaim({ ownerUserId: 'other-synthetic-owner', source: 'codex', originalId: 's' })).toBeNull();
  });
  it('refuses a matching mode with conflicting durable project provenance without writing history', async () => {
    const f = setup(), store = new ImportedHistoryStore(f.stateDir);
    await store.withWriter(async () => { store.assertOrClaimLocalSource({ ownerUserId: 'synthetic-owner', source: 'codex',
      originalId: 's', projectPath: '/other-synthetic-project', representation: 'canonical', parserContractVersion: 1 }); });
    f.opts.input.ownerUserId = 'synthetic-owner';
    await expect(runLocalHistoryParseJob(f.opts)).rejects.toThrow('parser-refused');
    expect(f.output).toHaveLength(0);
    expect(fs.readdirSync(path.join(f.stateDir, 'imported-history', 'conversations'))).toEqual([]);
  });
  it('streams an owned descriptor through the real child into a private disk artifact', async () => {
    const f = setup(); const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-pipeline-'));
    const sourcePath = path.join(directory, 'owned-source.jsonl');
    const targetPath = path.join(directory, 'normalized.part');
    const text = '👋'.repeat(30_000);
    const bytes = Buffer.from([
      { type: 'session_meta', payload: { id: 's', cwd: '/synthetic', source: 'cli' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
    ].map(value => JSON.stringify(value)).join('\n'));
    fs.chmodSync(directory, 0o700); fs.writeFileSync(sourcePath, bytes, { mode: 0o600 });
    const output = await fs.promises.open(targetPath, 'wx', 0o600);
    try {
      f.opts.input.bytes = bytes.length; f.opts.input.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      f.opts.chunks = signal => localSessionByteChunks({ filePath: sourcePath, source: 'codex',
        expectedSessionId: 's', expectedProjectPath: '/synthetic' }, { authorized: f.opts.authorized }, signal);
      let blocks = 0;
      f.opts.writeOutput = async block => { blocks++; const written = await output.write(block); expect(written.bytesWritten).toBe(block.length); };
      const receipt = await runLocalHistoryParseJob(f.opts);
      await output.sync(); await output.close();
      const actual = fs.readFileSync(targetPath);
      expect(receipt.sha256).toBe(crypto.createHash('sha256').update(actual).digest('hex'));
      expect(JSON.parse(actual.toString()).conversation.messages.map((m: {text: string}) => m.text).join('')).toBe(text);
      expect(blocks).toBeGreaterThan(1); expect(fs.statSync(targetPath).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(sourcePath)).toEqual(bytes); expect(f.released()).toBe(1);
    } finally {
      await output.close().catch(() => {});
      SafeFsExecutor.safeRmSync(directory, { recursive: true, force: true, operation: 'owned local history pipeline fixture cleanup' });
    }
  });

  it('aborts an input iterator when its real child dies before stdin finishes', async () => {
    const f = setup();
    f.opts.chunks = async function* (signal) {
      process.kill(f.childPid(), 'SIGKILL');
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    };
    await expect(runLocalHistoryParseJob(f.opts)).rejects.toThrow('parser-refused');
    expect(f.released()).toBe(1);
  });
  it('keeps authority monitoring active while output is pending after child exit', async () => {
    const f = setup(); let outputStarted = false;
    f.opts.writeOutput = async (_bytes, signal) => {
      outputStarted = true;
      const started = Date.now();
      while (true) {
        try { process.kill(f.childPid(), 0); }
        catch { break; }
        if (Date.now() - started > 5000) throw new Error('child failed to exit');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      f.setAuthorized(false);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('parent failed to abort pending output')), 3000);
        const done = () => { clearTimeout(timer); resolve(); };
        if (signal.aborted) done(); else signal.addEventListener('abort', done, { once: true });
      });
    };
    await expect(runLocalHistoryParseJob(f.opts)).rejects.toThrow('not-authorized');
    expect(outputStarted).toBe(true); expect(f.released()).toBe(1);
  });
  it('freezes commitments and callback references across asynchronous admission', async () => {
    const f = setup(); const acquire = f.opts.acquireChild;
    let admit!: () => void;
    const waiting = new Promise<void>(resolve => { admit = resolve; });
    f.opts.acquireChild = async () => { await waiting; return acquire(); };
    const pending = runLocalHistoryParseJob(f.opts);
    f.opts.input.sha256 = '0'.repeat(64); f.opts.heapMiB = 1;
    f.opts.authorized = () => false;
    f.opts.writeOutput = async () => { throw new Error('replaced callback'); };
    admit(); await pending;
    expect(f.output.length).toBeGreaterThan(0); expect(f.released()).toBe(1);
  });
  it('normalizes private callback failures and preserves prior refusal on cleanup failure', async () => {
    const f = setup(); f.opts.authorized = () => { throw new Error('/private/synthetic/state'); };
    f.opts.acquireChild = async () => ({
      custody: { stateDir: '/unused-revoked-custody', generation: '0'.repeat(64) },
      async registerChild() { throw new Error('must not spawn'); },
      release() { throw new Error('/private/synthetic/release'); },
    });
    const error = await runLocalHistoryParseJob(f.opts).catch(error => error);
    expect(error.message).toBe('local-history-not-authorized');
    expect(error.cleanupPending).toBe(true); expect(String(error)).not.toContain('/private');
  });
  it('normalizes registration failure after disposing the real spawned child', async () => {
    const f = setup(); const acquire = f.opts.acquireChild;
    f.opts.acquireChild = async () => {
      const lease = (await acquire())!;
      return { custody: lease.custody, async registerChild(pid) { await lease.registerChild(pid); throw new Error('/private/registration'); }, release: lease.release };
    };
    await expect(runLocalHistoryParseJob(f.opts)).rejects.toThrow('child-registration');
    expect(f.released()).toBe(1); expect(f.output).toHaveLength(0);
  });

  it('registers a real child before private input and releases admission only after its exit', async () => {
    const f = setup(); const receipt = await runLocalHistoryParseJob(f.opts);
    const output = Buffer.concat(f.output);
    expect(receipt.sha256).toBe(crypto.createHash('sha256').update(output).digest('hex'));
    expect(JSON.parse(output.toString()).conversation.messages[0].text).toBe('synthetic only');
    expect(f.released()).toBe(1);
  });
  it('refuses a stale custody generation in the real child before private source input', async () => {
    const f = setup(); const acquire = f.opts.acquireChild;
    f.opts.acquireChild = async () => {
      const lease = (await acquire())!;
      return { ...lease, custody: { ...lease.custody, generation: '0'.repeat(64) } };
    };
    await expect(runLocalHistoryParseJob(f.opts)).rejects.toThrow('parser-refused');
    expect(f.chunksRead()).toBe(0); expect(f.output).toHaveLength(0); expect(f.released()).toBe(1);
  });

  it('refuses busy admission before reading private bytes', async () => {
    const f = setup(); f.opts.acquireChild = async () => null;
    await expect(runLocalHistoryParseJob(f.opts)).rejects.toThrow('worker-busy');
    expect(f.chunksRead()).toBe(0); expect(f.output).toHaveLength(0);
  });
  it('refuses revoked authority before spawning or reading bytes', async () => {
    const f = setup(); f.setAuthorized(false);
    await expect(runLocalHistoryParseJob(f.opts)).rejects.toThrow('not-authorized');
    expect(f.chunksRead()).toBe(0); expect(f.released()).toBe(1);
  });
  it('stops on revoked authority during streaming and does not publish output', async () => {
    const f = setup(); f.opts.chunks = async function* () { f.setAuthorized(false); yield Buffer.from('not authorized'); };
    await expect(runLocalHistoryParseJob(f.opts)).rejects.toThrow('not-authorized');
    expect(f.output).toHaveLength(0); expect(f.released()).toBe(1);
  });
  it('terminates a deadline-expired real child and waits for exit before returning', async () => {
    const f = setup(); f.opts.deadlineMs = 50;
    f.opts.chunks = async function* (signal) {
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    };
    await expect(runLocalHistoryParseJob(f.opts)).rejects.toThrow('parser-timeout');
    expect(f.output).toHaveLength(0); expect(f.released()).toBe(1);
  });
  it('contains a private output-writer failure and keeps it out of public error text', async () => {
    const f = setup(); f.opts.writeOutput = async () => { throw new Error('private synthetic destination'); };
    await expect(runLocalHistoryParseJob(f.opts)).rejects.toThrow('parser-output');
    expect(f.released()).toBe(1);
  });
  it('refuses mismatched input commitments without a normalized output', async () => {
    const f = setup(); f.opts.input.sha256 = '0'.repeat(64);
    await expect(runLocalHistoryParseJob(f.opts)).rejects.toThrow('parser-input');
    expect(f.output).toHaveLength(0); expect(f.released()).toBe(1);
  });
});
