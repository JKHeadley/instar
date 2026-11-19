// The progress reporter of a slice inside the borrowed-machine helper sandbox
// (docs/specs/local-verify-borrowed-slices-count.md, E "Progress" and Build decisions "Progress
// leaves the sandbox through the root-owned runner").
//
// Installed at /usr/local/lib/instar-helper/progress-reporter.mjs (root:root 0644), outside every
// tree, and named to vitest by absolute path by the root-owned runner
// (`--reporter=json --reporter=<this file>`). It is NOT code of the tree under test: on a helper
// that tree is a waiting change.
//
// For each test file that finishes it writes ONE line to the slice's standard error:
//   INSTAR-HELPER-PROGRESS {"unhandled":<n>,"file":{…}}
// where `file` is that file's entry exactly as vitest's own JSON reporter will list it in the final
// report (name, status, startTime, endTime, assertionResults with ancestorTitles, fullName, status
// and title; failure messages are left out, the final report carries them), and `unhandled` is the
// run's unhandled-error count so far. Standard error is a pipe the runner opened; the runner passes
// on only lines with this prefix. Nothing is written to a file.
//
// What it reports is provisional by design: the helper's last signed answer for the slice must
// repeat every result, and the run machine uses nothing from progress otherwise.
//
// No imports from the tree and none from node_modules: only node's own modules.
import fs from 'node:fs';

export const PROGRESS_PREFIX = 'INSTAR-HELPER-PROGRESS';
/** A line over this many bytes is not written (the host's bound is 64 KB); the final report still lists the file. */
export const PROGRESS_LINE_MAX_BYTES = 60 * 1024;

// vitest's JSON reporter's own table (vitest 2.x `StatusMap`).
const STATUS = { fail: 'failed', only: 'pending', pass: 'passed', run: 'pending', skip: 'skipped', todo: 'todo' };

/** Every test of a file task, in order, as the JSON reporter's `getTests` returns them. */
export function testsOf(task, out = []) {
  for (const t of Array.isArray(task?.tasks) ? task.tasks : []) {
    if (t?.type === 'test' || t?.type === 'custom') out.push(t);
    else if (t?.type === 'suite') testsOf(t, out);
  }
  return out;
}

/** Whether every test of the file has reached its last state (none still running or waiting to run). */
export function fileSettled(file) {
  const state = file?.result?.state;
  if (state !== 'pass' && state !== 'fail' && state !== 'skip') return false;
  return testsOf(file).every((t) => {
    const s = t.result?.state;
    if (s === 'run') return false;
    // A test that will run but has no result yet is not finished; skipped and to-do tests never get one.
    return s !== undefined || t.mode === 'skip' || t.mode === 'todo';
  });
}

/** One file's entry, built the way vitest's JSON reporter builds it (minus failure messages, location and meta). */
export function fileEntry(file, runStart) {
  const tests = testsOf(file);
  let startTime = tests.reduce((prev, next) => Math.min(prev, next.result?.startTime ?? Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
  if (startTime === Number.POSITIVE_INFINITY) startTime = runStart;
  const endTime = tests.reduce((prev, next) => Math.max(prev, (next.result?.startTime ?? 0) + (next.result?.duration ?? 0)), startTime);
  const assertionResults = tests.map((t) => {
    const ancestorTitles = [];
    let iter = t.suite;
    while (iter) { ancestorTitles.push(iter.name); iter = iter.suite; }
    ancestorTitles.reverse();
    return {
      ancestorTitles,
      fullName: t.name ? [...ancestorTitles, t.name].join(' ') : ancestorTitles.join(' '),
      status: STATUS[t.result?.state || t.mode] || 'skipped',
      title: t.name,
      failureMessages: [],
    };
  });
  const hasFailedTests = tests.some((t) => t.result?.state === 'fail');
  return {
    assertionResults,
    startTime,
    endTime,
    status: file.result?.state === 'fail' || hasFailedTests ? 'failed' : 'passed',
    message: '',
    name: file.filepath,
  };
}

export default class InstarHelperProgressReporter {
  constructor(options = {}) {
    this.ctx = null;
    this.start = 0;
    this.emitted = new Set();
    // Synchronous, so a line is whole before the next test's output can follow it.
    this.write = typeof options.write === 'function' ? options.write : (line) => { try { fs.writeSync(2, line); } catch { /* the pipe is gone: the slice is being stopped */ } };
  }

  onInit(ctx) {
    this.ctx = ctx ?? null;
    this.start = Date.now();
  }

  unhandled() {
    try {
      const errors = this.ctx?.state?.getUnhandledErrors?.();
      return Array.isArray(errors) ? errors.length : 0;
    } catch { return 0; }
  }

  emit(file) {
    const name = file?.filepath;
    if (typeof name !== 'string' || this.emitted.has(name)) return;
    this.emitted.add(name);
    const line = `${PROGRESS_PREFIX} ${JSON.stringify({ unhandled: this.unhandled(), file: fileEntry(file, this.start) })}\n`;
    if (Buffer.byteLength(line) > PROGRESS_LINE_MAX_BYTES) return;
    this.write(line);
  }

  onTaskUpdate(packs = []) {
    const idMap = this.ctx?.state?.idMap;
    if (!idMap) return;
    for (const pack of packs) {
      const id = Array.isArray(pack) ? pack[0] : undefined;
      const task = typeof id === 'string' ? idMap.get(id) : undefined;
      // The file task itself reaching its last state ends the file.
      if (task && typeof task.filepath === 'string' && fileSettled(task)) this.emit(task);
    }
  }

  onFinished(files) {
    const all = Array.isArray(files) ? files : (this.ctx?.state?.getFiles?.() ?? []);
    for (const f of all) this.emit(f);
  }
}
