/** Evidence only. This module has no admission, read-suppression or model authority. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

const FILE_LIMIT = 4 * 1024 * 1024;
const TOTAL_LIMIT = 8 * 1024 * 1024;
const CHUNK_SIZE = 16 * 1024;
const PACKET_LIMIT = 16;
const OWNED_NAME = /^packet-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface SecurityPreflightFlags { enabled: boolean; sourceRoot: string | null }
export function securityPreflightFlags(config: unknown): SecurityPreflightFlags {
  const jobs = object(config) && object(config.jobs) ? config.jobs : {};
  const flag = object(jobs.securityReviewPreflight) ? jobs.securityReviewPreflight : {};
  return { enabled: flag.enabled === true, sourceRoot: typeof flag.sourceRoot === 'string'
    && path.isAbsolute(flag.sourceRoot) ? path.resolve(flag.sourceRoot) : null };
}
export interface SecurityPreflightRun {
  slug: string; sessionId: string; sessionName: string; runId: string; machineId: string;
  /** The actual dispatched prompt, kept byte-for-byte; never modified by this module. */
  prompt: string;
}
export interface PacketChunk { offset: number; bytes: number; sha256: string; base64: string }
export interface PacketSource {
  name: string; bytes: number; sha256: string; chunks: PacketChunk[];
}
export interface SecurityPreflightPacket {
  version: 1; evidenceOnly: true; packetId: string; createdAt: string;
  binding: Omit<SecurityPreflightRun, 'prompt'>; sourceRootHash: string;
  coverage: 'complete-declared-inputs';
  preflight: { lastPass: number; nextPass: number; codeTree: 'not-captured';
    modelReachability: 'not-probed'; delivery: 'not-proven'; semanticReview: 'not-proven' };
  sources: PacketSource[];
}
export type SecurityPreflightResult = { status: 'disabled' | 'busy' | 'unavailable' | 'recorded'; reason: string; packetId?: string };

export function packetSource(name: string, bytes: Buffer): PacketSource {
  const chunks: PacketChunk[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + CHUNK_SIZE);
    chunks.push({ offset, bytes: chunk.length, sha256: sha(chunk), base64: chunk.toString('base64') });
  }
  return { name, bytes: bytes.length, sha256: sha(bytes), chunks };
}

/** A strict local consumer can verify coverage without interpreting Markdown or UTF-8 chunks. */
export function verifyPacketSource(source: PacketSource): Buffer | null {
  if (!object(source) || !Number.isSafeInteger(source.bytes) || source.bytes < 0 || source.bytes > FILE_LIMIT || !Array.isArray(source.chunks) || source.chunks.length > Math.ceil(FILE_LIMIT / CHUNK_SIZE)) return null;
  let offset = 0; const buffers: Buffer[] = [];
  for (const [index, c] of source.chunks.entries()) {
    if (!object(c) || typeof c.base64 !== 'string' || c.base64.length > Math.ceil(CHUNK_SIZE / 3) * 4) return null;
    const b = Buffer.from(c.base64, 'base64');
    if (b.toString('base64') !== c.base64 || c.offset !== offset || c.bytes !== b.length || b.length === 0
      || b.length > CHUNK_SIZE || (index < source.chunks.length - 1 && b.length !== CHUNK_SIZE) || sha(b) !== c.sha256) return null;
    buffers.push(b); offset += b.length;
    if (offset > source.bytes) return null;
  }
  const b = Buffer.concat(buffers);
  return offset === source.bytes && sha(b) === source.sha256 ? b : null;
}

export class SecurityReviewPreflight {
  private busy = false;
  constructor(private readonly options: { stateDir: string; flags: () => SecurityPreflightFlags; canWrite: () => boolean }) {}

  async capture(run: SecurityPreflightRun): Promise<SecurityPreflightResult> {
    // Off means no filesystem access, including existence checks or mkdir.
    const flags = { ...this.options.flags() };
    run = { ...run };
    if (!flags.enabled || run.slug !== 'security-review') return { status: 'disabled', reason: 'off' };
    if (this.busy) return { status: 'busy', reason: 'capture-in-flight' };
    if (!flags.sourceRoot) return { status: 'unavailable', reason: 'source-root-required' };
    this.busy = true;
    let temporary: string | undefined;
    try {
      if (!this.options.canWrite() || [run.sessionId, run.runId, run.sessionName, run.machineId].some(v => typeof v !== 'string' || v.length === 0 || v.length > 256)
        || Buffer.byteLength(run.prompt) > FILE_LIMIT) throw new Error('unavailable');
      const stateRoot = await fs.realpath(this.options.stateDir);
      const sourceRoot = await fs.realpath(flags.sourceRoot);
      const specs = [
        { name: 'findings-ledger', file: path.join(stateRoot, 'state/security/private/findings.md') },
        { name: 'threat-map', file: path.join(sourceRoot, 'docs/security/threat-map.md') },
        { name: 'rotation-state', file: path.join(stateRoot, 'state/security/review-state.json') },
      ];
      const snapshots: { name: string; file: string; fingerprint: string; bytes: Buffer }[] = [];
      let total = Buffer.byteLength(run.prompt);
      for (const spec of specs) {
        // Never follow an installed input symlink into an unrelated file.
        if (await fs.realpath(spec.file) !== spec.file) throw new Error('unavailable');
        const handle = await fs.open(spec.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const before = await handle.stat();
          if (!before.isFile() || before.size > FILE_LIMIT) throw new Error('unavailable');
          total += before.size; if (total > TOTAL_LIMIT) throw new Error('unavailable');
          const bytes = Buffer.alloc(before.size); let offset = 0;
          while (offset < bytes.length) {
            const read = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
            if (read.bytesRead === 0) throw new Error('unavailable');
            offset += read.bytesRead;
          }
          const fingerprint = (s: typeof before) => [s.dev, s.ino, s.birthtimeMs, s.size, s.mtimeMs, s.ctimeMs].join(':');
          const expected = fingerprint(before);
          if (fingerprint(await handle.stat()) !== expected) throw new Error('unavailable');
          snapshots.push({ ...spec, fingerprint: expected, bytes });
        } finally { await handle.close(); }
      }
      const rotation: unknown = JSON.parse(snapshots[2].bytes.toString('utf8'));
      if (!object(rotation) || !Number.isInteger(rotation.lastPass) || Number(rotation.lastPass) < 0 || Number(rotation.lastPass) > 3) throw new Error('unavailable');
      const sources = snapshots.map(s => packetSource(s.name, s.bytes));
      sources.push(packetSource('dispatched-prompt', Buffer.from(run.prompt)));
      // Recheck every input after all reads; never claim a cross-file stable window from individual reads alone.
      for (const source of snapshots) {
        const stat = await fs.lstat(source.file);
        if (!stat.isFile() || [stat.dev, stat.ino, stat.birthtimeMs, stat.size, stat.mtimeMs, stat.ctimeMs].join(':') !== source.fingerprint
          || await fs.realpath(source.file) !== source.file) throw new Error('unavailable');
      }
      const { prompt: _prompt, ...binding } = run;
      const packet: SecurityPreflightPacket = { version: 1, evidenceOnly: true, packetId: randomUUID(),
        createdAt: new Date().toISOString(), binding, sourceRootHash: sha(sourceRoot), coverage: 'complete-declared-inputs',
        preflight: { lastPass: Number(rotation.lastPass), nextPass: Number(rotation.lastPass) % 3 + 1,
          codeTree: 'not-captured', modelReachability: 'not-probed', delivery: 'not-proven', semanticReview: 'not-proven' }, sources };
      const dir = path.join(stateRoot, 'state/security/private/review-packets');
      // Private source content must not be persisted underneath a symlink or a permissive private parent.
      const parent = path.dirname(dir); const parentStat = await fs.lstat(parent);
      if (!parentStat.isDirectory() || await fs.realpath(parent) !== parent || (parentStat.mode & 0o077) !== 0) throw new Error('unavailable');
      if (!this.options.canWrite()) throw new Error('unavailable');
      await fs.mkdir(dir, { mode: 0o700, recursive: true });
      if (!(await fs.lstat(dir)).isDirectory() || await fs.realpath(dir) !== dir) throw new Error('unavailable');
      await fs.chmod(dir, 0o700);
      const entries: string[] = []; const directory = await fs.opendir(dir);
      for await (const entry of directory) { entries.push(entry.name); if (entries.length > 128) throw new Error('unavailable'); }
      const owned: { file: string; mtime: number }[] = [];
      for (const name of entries.filter(n => OWNED_NAME.test(n))) {
        const file = path.join(dir, name); const stat = await fs.lstat(file);
        if (stat.isFile()) owned.push({ file, mtime: stat.mtimeMs });
      }
      // Class-B derived evidence: keep16 private packets, never touch source ledger or unknown files.
      owned.sort((a, b) => a.mtime - b.mtime);
      while (owned.length >= PACKET_LIMIT) {
        if (!this.options.canWrite()) throw new Error('unavailable');
        await SafeFsExecutor.safeUnlink(owned.shift()!.file, { operation: 'SecurityReviewPreflight:retention' });
      }
      const final = path.join(dir, `packet-${packet.packetId}.json`);
      temporary = path.join(dir, `packet-${packet.packetId}.tmp`);
      await fs.writeFile(temporary, JSON.stringify(packet), { flag: 'wx', mode: 0o600 });
      const current = this.options.flags();
      if (!current.enabled || current.sourceRoot !== flags.sourceRoot || !this.options.canWrite()) throw new Error('unavailable');
      await fs.rename(temporary, final); temporary = undefined;
      return { status: 'recorded', reason: 'complete-declared-inputs-evidence-only', packetId: packet.packetId };
    } catch {
      // @silent-fallback-ok — diagnostic packet failure never changes normal review or exposes private content.
      return { status: 'unavailable', reason: 'inputs-or-storage-unavailable' };
    } finally {
      if (temporary) {
        try { await SafeFsExecutor.safeUnlink(temporary, { operation: 'SecurityReviewPreflight:failed-capture' }); }
        catch { /* @silent-fallback-ok — exact owned private temp retained on cleanup failure; never read as a packet. */ }
      }
      this.busy = false;
    }
  }
}
