/**
 * CMT-2289 — after a FAILED LLM detection call, PromptGate does not re-ask the
 * same unchanged pane every tick; it backs off, reports the failure CLASS at a
 * bounded rate, and re-checks at once on a changed pane, sent input, success or
 * cleanup.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InputDetector, type InputDetectorConfig } from '../../src/monitoring/PromptGate.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';

const CONFIG: InputDetectorConfig = { detectionWindowLines: 50, enabled: true };

function makeIntel(behaviour: () => Promise<string>) {
  let calls = 0;
  return {
    evaluate: async () => { calls += 1; return behaviour(); },
    get calls() { return calls; },
  };
}
const failing = () => Promise.reject(new Error('Gemini CLI error: Command failed: gemini — auth: not-logged-in'));

async function flush(): Promise<void> { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); }
async function fire(d: InputDetector, s: string, out: string): Promise<void> {
  d.onCapture(s, out); d.onCapture(s, out); d.onCapture(s, out);
  await flush();
}
async function pump(d: InputDetector, s: string, out: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) { d.onCapture(s, out); await new Promise((r) => setImmediate(r)); }
}

let now = 1_000_000;
afterEach(() => { vi.restoreAllMocks(); now = 1_000_000; });
function clock() { vi.spyOn(Date, 'now').mockImplementation(() => now); }

describe('PromptGate LLM failure backoff (CMT-2289)', () => {
  it('an unchanged pane is not re-asked while backing off after a failure', async () => {
    clock();
    const report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined as never);
    const intel = makeIntel(failing);
    const d = new InputDetector({ ...CONFIG, intelligence: intel as any });
    const out = 'Idle pane\n❯ \n';

    await fire(d, 's1', out);
    expect(intel.calls).toBe(1);
    await pump(d, 's1', out, 40); // every tick for the same pane
    expect(intel.calls).toBe(1);

    // After the 30 s backoff the same pane is asked once more, then backs off 60 s.
    now += 31_000;
    await pump(d, 's1', out, 3);
    expect(intel.calls).toBe(2);
    now += 31_000; // inside the doubled 60 s window
    await pump(d, 's1', out, 3);
    expect(intel.calls).toBe(2);
    // The failure is reported once, with the class only.
    expect(report).toHaveBeenCalledTimes(1);
    const arg = report.mock.calls[0][0] as { feature: string; reason: string };
    expect(arg.feature).toBe('PromptGate.llmDetect');
    expect(arg.reason).toContain('class: auth');
    expect(arg.reason).not.toContain('not-logged-in');
    // An auth failure keeps doubling up to the 5-minute cap.
    for (let i = 0; i < 6; i++) { now += 5 * 60_000 + 1_000; await pump(d, 's1', out, 1); }
    const before = intel.calls;
    now += 4 * 60_000; // still inside the 5-minute cap
    await pump(d, 's1', out, 2);
    expect(intel.calls).toBe(before);

  });

  it('a changed pane is checked at once even during a backoff', async () => {
    clock();
    vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined as never);
    const intel = makeIntel(failing);
    const d = new InputDetector({ ...CONFIG, intelligence: intel as any });
    await fire(d, 's1', 'Pane A\n❯ \n');
    await fire(d, 's1', 'Pane B, new output\n❯ \n');
    expect(intel.calls).toBe(2);
  });

  it('sent input clears the backoff', async () => {
    clock();
    vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined as never);
    const intel = makeIntel(failing);
    const d = new InputDetector({ ...CONFIG, intelligence: intel as any });
    const out = 'Same pane\n❯ \n';
    await fire(d, 's1', out);
    d.onInputSent('s1');
    await fire(d, 's1', out);
    expect(intel.calls).toBe(2);
  });

  it('a successful call clears the backoff (and the NO_PROMPT cache then applies as before)', async () => {
    clock();
    vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined as never);
    let fail = true;
    const intel = makeIntel(() => (fail ? failing() : Promise.resolve('NO_PROMPT')));
    const d = new InputDetector({ ...CONFIG, intelligence: intel as any });
    const out = 'Recovering pane\n❯ \n';
    await fire(d, 's1', out);
    fail = false;
    now += 61_000;
    await pump(d, 's1', out, 3);
    expect(intel.calls).toBe(2);
    await pump(d, 's1', out, 20);
    expect(intel.calls).toBe(2); // cached NO_PROMPT now, no further calls
  });

  it('degradation reports are rate-limited per error class', async () => {
    clock();
    const report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined as never);
    const intel = makeIntel(failing);
    const d = new InputDetector({ ...CONFIG, intelligence: intel as any });
    for (let i = 0; i < 5; i++) await fire(d, `s${i}`, `pane ${i}\n❯ \n`);
    expect(intel.calls).toBe(5);
    expect(report).toHaveBeenCalledTimes(1);
    now += 31 * 60_000;
    await fire(d, 's-late', 'late pane\n❯ \n');
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('a passing failure class (rate limit, capacity, timeout) backs off at most 1 minute', async () => {
    clock();
    vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined as never);
    const intel = makeIntel(() => Promise.reject(new Error('timeout')));
    const d = new InputDetector({ ...CONFIG, intelligence: intel as any });
    const out = 'Slow provider pane\n❯ \n';
    await fire(d, 's1', out);
    for (let i = 0; i < 5; i++) { now += 61_000; await pump(d, 's1', out, 1); }
    expect(intel.calls).toBe(6); // re-asked after every minute, never longer
  });

  it('input sent while a failing call is in flight does not back off the stale screen', async () => {
    clock();
    vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined as never);
    let rejectNow!: (e: Error) => void;
    let first = true;
    const intel = makeIntel(() => {
      if (first) { first = false; return new Promise<string>((_, rej) => { rejectNow = rej; }); }
      return Promise.reject(new Error('Command failed — auth: not-logged-in'));
    });
    const d = new InputDetector({ ...CONFIG, intelligence: intel as any });
    const out = 'In-flight pane\n❯ \n';
    await fire(d, 's1', out);
    d.onInputSent('s1');
    rejectNow(new Error('Command failed — auth: not-logged-in'));
    await flush();
    await fire(d, 's1', out); // same screen, but no backoff was recorded
    expect(intel.calls).toBe(2);
  });

  it('a throw while emitting after a SUCCESSFUL call is not treated as an LLM failure', async () => {
    clock();
    const report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined as never);
    const intel = makeIntel(() => Promise.resolve('{"type":"permission","summary":"Allow?","options":[{"key":"1","label":"Yes"}]}'));
    const d = new InputDetector({ ...CONFIG, intelligence: intel as any });
    d.on('prompt', () => { throw new Error('listener boom'); });
    await fire(d, 's1', 'Allow this?\n  1. Yes\n');
    expect(intel.calls).toBe(1);
    expect(report).not.toHaveBeenCalled();
  });
});
