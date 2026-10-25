/**
 * claudeResumeTranscript — make a Claude Code conversation openable from the
 * login (config home) a launch will run under, without ever losing a turn.
 *
 * Standards: "Verify the State, Not Its Symbol" (docs/STANDARDS-REGISTRY.md) —
 * a transcript existing *somewhere* is not proof the launching login can open
 * it; Claude reads resume transcripts only from `<CLAUDE_CONFIG_DIR>/projects`.
 * Spec: docs/specs/resume-follows-account.md §3.1.
 *
 * Incident (2026-09-16, sagemind topic 32175): a conversation recorded under
 * one pool account was resumed under another after the first hit its weekly
 * limit; the second login had no copy, Claude printed "No conversation found"
 * and exited, and the topic looped. This module places the freshest copy in
 * the target login first.
 *
 * No-loss rules (a copy is never deleted or truncated):
 *   - target has no copy            → copy in            ('copied')
 *   - target already has the chosen → nothing            ('present')
 *   - target has an older byte-prefix of the chosen copy → replace ('replaced')
 *   - target has a divergent copy   → rename it aside to `<uuid>.jsonl.forked-<ts>`,
 *                                     then copy in       ('forked')
 * An internal one-shot `claude -p` transcript (entrypoint `sdk-cli`) is never a
 * topic conversation and is refused ('one-shot').
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export type PlacementOutcome =
  | 'present'
  | 'copied'
  | 'replaced'
  | 'forked'
  | 'one-shot'
  | 'not-found'
  | 'error';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Backward scan bound for the freshness timestamp (real lines reach ~1 MB, so bound by lines, not bytes). */
const FRESHNESS_MAX_LINES = 500;
const FRESHNESS_MAX_BYTES = 16 * 1024 * 1024;
/** Forward scan bound for the first `cwd`-bearing record (measured at lines 2-6, under 3 KB). */
const HEAD_MAX_BYTES = 64 * 1024;

export function isCanonicalUuid(uuid: string): boolean {
  return UUID_RE.test(uuid);
}

/** `~/.claude` plus every `~/.claude-*` directory — the same set the account-swap helper has always scanned. */
export function claudeConfigHomes(homeDir: string = os.homedir()): string[] {
  const homes: string[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(homeDir);
  } catch {
    // @silent-fallback-ok — an unreadable HOME yields no candidate homes; callers treat that as not-found.
    return homes;
  }
  for (const name of entries) {
    if (name !== '.claude' && !name.startsWith('.claude-')) continue;
    const full = path.join(homeDir, name);
    try {
      if (fs.lstatSync(full).isDirectory()) homes.push(full);
    } catch {
      // @silent-fallback-ok — a vanished entry is simply not a candidate.
    }
  }
  return homes;
}

export function expandHome(p: string, homeDir: string = os.homedir()): string {
  return p === '~' ? homeDir : p.startsWith('~/') ? path.join(homeDir, p.slice(2)) : p;
}

interface Copy {
  home: string;
  slug: string;
  file: string;
  size: number;
  lastTimestamp: string;
}

function isRegularFile(p: string): boolean {
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
}

/** Every copy of `<uuid>.jsonl` under any project folder of `home`. */
function locateInHome(home: string, uuid: string): Array<{ slug: string; file: string }> {
  const projects = path.join(home, 'projects');
  let slugs: string[] = [];
  try {
    slugs = fs.readdirSync(projects);
  } catch {
    // @silent-fallback-ok — a home without a projects folder holds no transcripts.
    return [];
  }
  const out: Array<{ slug: string; file: string }> = [];
  for (const slug of slugs) {
    const file = path.join(projects, slug, `${uuid}.jsonl`);
    if (isRegularFile(file)) out.push({ slug, file });
  }
  return out;
}

/** Latest top-level `timestamp` among the last lines of a transcript ('' when none is found). */
export function lastRecordTimestamp(file: string): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    let pos = size;
    let carry = Buffer.alloc(0);
    let lines = 0;
    let scanned = 0;
    while (pos > 0 && lines < FRESHNESS_MAX_LINES && scanned < FRESHNESS_MAX_BYTES) {
      const step = Math.min(256 * 1024, pos);
      pos -= step;
      const chunk = Buffer.alloc(step);
      fs.readSync(fd, chunk, 0, step, pos);
      scanned += step;
      // Split on raw newline bytes so a multi-byte character cut by the chunk
      // boundary stays intact in the carried remainder.
      let buf = Buffer.concat([chunk, carry]);
      let nl = buf.lastIndexOf(0x0a);
      while (nl !== -1) {
        const line = buf.subarray(nl + 1);
        buf = buf.subarray(0, nl);
        lines++;
        const ts = timestampOf(line.toString('utf-8'));
        if (ts) return ts;
        if (lines >= FRESHNESS_MAX_LINES) return '';
        nl = buf.lastIndexOf(0x0a);
      }
      carry = Buffer.from(buf);
    }
    if (pos === 0) {
      const ts = timestampOf(carry.toString('utf-8'));
      if (ts) return ts;
    }
    return '';
  } catch {
    // @silent-fallback-ok — an unreadable copy ranks last by timestamp; size still orders it.
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* @silent-fallback-ok — close of a read-only fd */ }
    }
  }
}

function timestampOf(line: string): string {
  if (!line || line[0] !== '{') return '';
  try {
    const rec = JSON.parse(line) as { timestamp?: unknown };
    return typeof rec.timestamp === 'string' ? rec.timestamp : '';
  } catch {
    return '';
  }
}

/** The `entrypoint` of the first record carrying `cwd` (undefined when none is found in the head). */
export function firstCwdRecordEntrypoint(file: string): string | undefined {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_MAX_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_MAX_BYTES, 0);
    const lines = buf.subarray(0, n).toString('utf-8').split('\n');
    for (const line of lines) {
      if (!line || line[0] !== '{') continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // a truncated final line in the head window
      }
      if (typeof rec.cwd === 'string') {
        return typeof rec.entrypoint === 'string' ? rec.entrypoint : undefined;
      }
    }
    return undefined;
  } catch {
    // @silent-fallback-ok — unreadable head: not refused (today's behaviour).
    return undefined;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* @silent-fallback-ok — close of a read-only fd */ }
    }
  }
}

function freshestFirst(a: Copy, b: Copy): number {
  if (a.lastTimestamp !== b.lastTimestamp) {
    if (!a.lastTimestamp) return 1;
    if (!b.lastTimestamp) return -1;
    return a.lastTimestamp > b.lastTimestamp ? -1 : 1;
  }
  return b.size - a.size;
}

async function isBytePrefix(shorter: string, longer: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([fsp.stat(shorter), fsp.stat(longer)]);
  if (sa.size > sb.size) return false;
  const ha = await fsp.open(shorter, 'r');
  const hb = await fsp.open(longer, 'r');
  try {
    const chunk = 1024 * 1024;
    const ba = Buffer.alloc(chunk);
    const bb = Buffer.alloc(chunk);
    let pos = 0;
    while (pos < sa.size) {
      const want = Math.min(chunk, sa.size - pos);
      const ra = await ha.read(ba, 0, want, pos);
      const rb = await hb.read(bb, 0, want, pos);
      if (ra.bytesRead !== want || rb.bytesRead !== want) return false;
      if (!ba.subarray(0, want).equals(bb.subarray(0, want))) return false;
      pos += want;
    }
    return true;
  } finally {
    await ha.close();
    await hb.close();
  }
}

function tempName(dir: string, uuid: string): string {
  return path.join(dir, `.${uuid}.jsonl.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
}

async function copyInto(src: string, dst: string, uuid: string): Promise<void> {
  const dir = path.dirname(dst);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = tempName(dir, uuid);
  try {
    await fsp.copyFile(src, tmp, fs.constants.COPYFILE_FICLONE);
    await fsp.chmod(tmp, 0o600);
    await fsp.rename(tmp, dst);
  } catch (err) {
    await SafeFsExecutor.safeUnlink(tmp, { operation: 'claudeResumeTranscript.copyInto:temp-cleanup' })
      .catch(() => { /* @silent-fallback-ok — the temp file may never have been created */ });
    throw err;
  }
}

/** Copy attachment files that the target lacks; never overwrite, never follow symlinks. */
async function mergeAttachments(srcDir: string, dstDir: string, depth = 0): Promise<void> {
  if (depth > 3) return;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(srcDir, { withFileTypes: true });
  } catch {
    return; // @silent-fallback-ok — no attachment folder to merge
  }
  await fsp.mkdir(dstDir, { recursive: true, mode: 0o700 });
  for (const e of entries) {
    const s = path.join(srcDir, e.name);
    const d = path.join(dstDir, e.name);
    if (e.isDirectory()) {
      await mergeAttachments(s, d, depth + 1);
    } else if (e.isFile()) {
      try {
        await fsp.copyFile(s, d, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
        await fsp.chmod(d, 0o600);
      } catch {
        // @silent-fallback-ok — EEXIST keeps the target's file; a missing attachment never blocks a resume.
      }
    }
  }
}

/**
 * Place the freshest copy of conversation `uuid` into `targetConfigHome` so a
 * Claude launch under that login can `--resume` it. Never throws.
 */
export async function placeResumeTranscript(
  uuid: string,
  targetConfigHome: string,
  homeDir: string = os.homedir(),
): Promise<PlacementOutcome> {
  if (!isCanonicalUuid(uuid)) return 'not-found';
  try {
    const target = path.resolve(expandHome(targetConfigHome, homeDir));
    const homes = new Set(claudeConfigHomes(homeDir).map((h) => path.resolve(h)));
    homes.add(target);

    const copies: Copy[] = [];
    for (const home of homes) {
      for (const { slug, file } of locateInHome(home, uuid)) {
        let size = 0;
        try { size = fs.statSync(file).size; } catch { continue; }
        copies.push({ home, slug, file, size, lastTimestamp: lastRecordTimestamp(file) });
      }
    }
    if (copies.length === 0) return 'not-found';
    copies.sort(freshestFirst);
    const chosen = copies[0];
    if (firstCwdRecordEntrypoint(chosen.file) === 'sdk-cli') return 'one-shot';

    const dst = path.join(target, 'projects', chosen.slug, `${uuid}.jsonl`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // Claude opens a resume by id from ANY project folder of its login, so a
    // second copy under another folder of the target could shadow the one we
    // place. Keep exactly one openable copy: set the others aside (never delete).
    for (const other of copies.filter((c) => c.home === target && c.file !== dst && c.file !== chosen.file)) {
      await fsp.rename(other.file, `${other.file}.forked-${stamp}`);
    }
    // The chosen copy already lives in the target login.
    if (chosen.home === target) return 'present';

    const existing = copies.find((c) => c.file === dst);
    let outcome: PlacementOutcome = 'copied';
    if (existing) {
      const sameOrNewer =
        existing.lastTimestamp !== '' &&
        existing.lastTimestamp >= chosen.lastTimestamp &&
        existing.size >= chosen.size;
      if (sameOrNewer) return 'present';
      const before = await fsp.stat(existing.file);
      if (await isBytePrefix(existing.file, chosen.file)) {
        // Re-check just before replacing: if anything wrote to the target since
        // the comparison, leave it alone rather than risk losing that write.
        const after = await fsp.stat(existing.file);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return 'present';
        outcome = 'replaced';
      } else {
        await fsp.rename(dst, `${dst}.forked-${stamp}`);
        outcome = 'forked';
      }
    }
    await copyInto(chosen.file, dst, uuid);
    await mergeAttachments(
      path.join(chosen.home, 'projects', chosen.slug, uuid),
      path.join(target, 'projects', chosen.slug, uuid),
    );
    return outcome;
  } catch {
    // @silent-fallback-ok — reported by the caller as outcome 'error'; the launch keeps today's behaviour.
    return 'error';
  }
}
