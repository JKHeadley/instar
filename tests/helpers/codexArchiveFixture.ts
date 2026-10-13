/**
 * Synthetic Codex rollout archives for the resume-lookup tests.
 *
 * Codex writes `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`,
 * partitioned by LOCAL date, with UUIDv7 thread ids whose first 48 bits are
 * the creation instant. These helpers build archives of any size (the
 * 2026-10-13 freeze was a 286,984-file archive) without ever reading a real one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function makeFakeHome(prefix = 'codex-archive-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function codexHomeOf(home: string): string {
  return path.join(home, '.codex');
}

/** `YYYY/MM/DD` of a local instant — the partition Codex writes that session to. */
export function localPartitionOf(when: Date): string {
  return `${when.getFullYear()}/${pad2(when.getMonth() + 1)}/${pad2(when.getDate())}`;
}

/** A UUIDv7 whose embedded timestamp is `when` (local instant), with a deterministic tail. */
export function uuidV7At(when: Date, seed: number): string {
  const ms = when.getTime().toString(16).padStart(12, '0');
  const tail = (seed >>> 0).toString(16).padStart(8, '0');
  const rand3 = ((seed * 2654435761) >>> 0).toString(16).padStart(8, '0').slice(0, 3);
  return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7${rand3}-8${rand3}-${tail}${rand3.slice(0, 1)}abc`;
}

/** A UUIDv4-shaped id (what a Claude session id looks like) — carries no date. */
export function uuidV4Like(seed: number): string {
  const h = (n: number): string => ((seed * n) >>> 0).toString(16).padStart(8, '0');
  return `${h(1)}-${h(2).slice(0, 4)}-4${h(3).slice(0, 3)}-a${h(4).slice(0, 3)}-${h(5)}${h(6).slice(0, 4)}`;
}

export function rolloutDir(home: string, ymd: string): string {
  return path.join(codexHomeOf(home), 'sessions', ymd);
}

/** Write one rollout file for `uuid` under the `ymd` partition; returns its path. */
export function writeRollout(home: string, uuid: string, ymd: string, ts = '2026-05-30T12-00-00'): string {
  const dir = rolloutDir(home, ymd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${ts}-${uuid}.jsonl`);
  fs.writeFileSync(file, '{"type":"thread.started"}\n');
  return file;
}

/**
 * Build a large date-partitioned archive: `partitions` consecutive days ending
 * at `end` (local), `perPartition` rollouts each, every file a realistic
 * `rollout-<ts>-<uuidv7>.jsonl`. Returns the partitions oldest-first.
 */
export function buildLargeArchive(
  home: string,
  opts: { partitions: number; perPartition: number; end?: Date },
): { files: number; partitions: string[] } {
  const end = opts.end ?? new Date(2026, 9, 12, 12, 0, 0);
  const partitions: string[] = [];
  let files = 0;
  for (let p = opts.partitions - 1; p >= 0; p--) {
    const day = new Date(end);
    day.setDate(day.getDate() - p);
    const ymd = localPartitionOf(day);
    const dir = rolloutDir(home, ymd);
    fs.mkdirSync(dir, { recursive: true });
    partitions.push(ymd);
    const ts = `${day.getFullYear()}-${pad2(day.getMonth() + 1)}-${pad2(day.getDate())}T08-00-00`;
    for (let i = 0; i < opts.perPartition; i++) {
      const uuid = uuidV7At(new Date(day.getTime() + i * 1000), p * 100_000 + i + 1);
      fs.closeSync(fs.openSync(path.join(dir, `rollout-${ts}-${uuid}.jsonl`), 'w'));
      files++;
    }
  }
  return { files, partitions };
}

/** A tmux stand-in that reports a live pane for every session (TopicResumeMap probes it). */
export function writeTmuxStub(dir: string): string {
  const file = path.join(dir, 'tmux-stub.sh');
  fs.writeFileSync(file, '#!/bin/sh\n# display-message -p "#{pane_id}||#{pane_dead}" → live pane; has-session → 0\necho "%1||0"\nexit 0\n');
  fs.chmodSync(file, 0o755);
  return file;
}

/** Measure the longest event-loop stall while running; `stop()` returns it in ms. */
export function startEventLoopLagProbe(intervalMs = 5): { stop: () => number } {
  let last = Date.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last - intervalMs);
    last = now;
  }, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
      return worst;
    },
  };
}
