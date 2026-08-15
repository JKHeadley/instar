/**
 * Unit — the census of ways into the CLOSED headless lane (grok-build spec §8).
 *
 * WHY THIS EXISTS. On a grok-only agent the headless lane refuses
 * (`grok-headless-cwd-ungated`) and there is no other enabled framework to fall
 * back to, so EVERYTHING that needs a headless spawn is dead. The spec first
 * scoped that damage to "33 scheduled jobs", because scheduled jobs were what we
 * happened to observe. Then a Threadline message to the grok agent was accepted
 * and never handled — a SECOND consumer, found the same way, by running it.
 *
 * Two instances found by accident is a signal that the list was never derived.
 * So it was derived: every path into the lane goes through `buildHeadlessLaunch`,
 * and across `src/` there are exactly TWO call sites. That is the census, and
 * this test pins it, so a third consumer cannot appear silently the way the
 * second one did.
 *
 * This asserts a COUNT and its OWNERS, not behaviour — deliberately. The point is
 * that the blast radius of a closed lane stays enumerated. If you add a call
 * site, this test fails and you update the spec's consequence list in the same
 * change, which is the whole intent.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../src');

/** Every `.ts` under src/, recursively. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * CALL sites only — an import or a mention inside a comment is not a way into
 * the lane. Matches `buildHeadlessLaunch(` and drops lines that are an import or
 * a comment, which is what separates the 2 real entrypoints from the textual
 * mentions.
 */
function headlessCallSites(): { file: string; line: number }[] {
  const hits: { file: string; line: number }[] = [];
  for (const file of walk(SRC)) {
    // The definition itself is not a call site.
    if (file.endsWith(path.join('core', 'frameworkSessionLaunch.ts'))) continue;
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    lines.forEach((raw, i) => {
      const text = raw.trim();
      if (!text.includes('buildHeadlessLaunch(')) return;
      if (text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')) return;
      if (text.startsWith('import') || text.includes('} from')) return;
      hits.push({ file: path.relative(SRC, file), line: i + 1 });
    });
  }
  return hits;
}

describe('headless-lane entrypoint census', () => {
  it('CONTROL: the walker finds source and the matcher finds something', () => {
    // Without this, a broken walker (wrong root, bad extension filter) would
    // report zero call sites and the census below would pass while measuring
    // nothing — the "passing condition narrower than what it certifies" shape.
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(100);
    expect(headlessCallSites().length).toBeGreaterThan(0);
  });

  it('there are exactly TWO ways into the headless lane, and these are they', () => {
    const owners = headlessCallSites()
      .map((h) => h.file)
      .sort();

    // Each entry is a consumer that DIES on a grok-only agent while the lane is
    // closed. BOTH were discovered by running it, not by reading:
    //   core/SessionManager.ts   — scheduled jobs (the 33 failing ones), and the
    //                              path POST /sessions/spawn arrives through
    //   threadline/PipeSession…  — agent-to-agent INGRESS (found 2026-08-15;
    //                              messages accepted, queued, never handled)
    //
    // I first wrote THREE here, counting server/routes.ts, because that file
    // names `buildHeadlessLaunch` in a comment about validating the framework
    // set. It does not call it — POST /sessions/spawn reaches the lane THROUGH
    // SessionManager, which is the correct shape. This test caught that before
    // the wrong number reached the spec, which is the entire reason to measure a
    // census rather than assert one.
    expect(owners).toEqual(['core/SessionManager.ts', 'threadline/PipeSessionSpawner.ts']);
  });

  it('CONTROL: comments and imports are NOT counted as entrypoints', () => {
    // `buildHeadlessLaunch` is mentioned ~9 times across src/ in prose and
    // imports. If those counted, the census would drift with every comment edit
    // and would stop meaning "ways in" — so the filter is load-bearing and gets
    // its own check rather than being trusted.
    const rawMentions = walk(SRC)
      .filter((f) => !f.endsWith(path.join('core', 'frameworkSessionLaunch.ts')))
      .reduce(
        (n, f) => n + (fs.readFileSync(f, 'utf-8').match(/buildHeadlessLaunch/g)?.length ?? 0),
        0,
      );
    expect(rawMentions).toBeGreaterThan(headlessCallSites().length);
  });
});
