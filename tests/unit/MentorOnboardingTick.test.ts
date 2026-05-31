/**
 * Tier-1 unit tests for runMentorTick — the structural core of one mentor
 * heartbeat (FRAMEWORK-ONBOARDING-MENTOR-SPEC §3/§4/§6/§19.4).
 *
 * Every side effect is injected, so the load-bearing order — canary → budget →
 * safe-window → Stage A → leak → Stage B → capture — is asserted without tmux,
 * an LLM, or a server.
 */
import { describe, it, expect, vi } from 'vitest';
import { runMentorTick, type MentorTickDeps } from '../../src/scheduler/MentorOnboardingTick.js';
import type { CaptureRunInput, CaptureRunResult } from '../../src/monitoring/FrameworkIssueLedger.js';

function makeDeps(over: Partial<MentorTickDeps> = {}): { deps: MentorTickDeps; captures: CaptureRunInput[] } {
  const captures: CaptureRunInput[] = [];
  const capture = (input: CaptureRunInput): CaptureRunResult => {
    captures.push(input);
    return {
      runId: 'r1',
      framework: input.framework,
      findingsCount: input.findings.length,
      observationsWritten: input.findings.length,
      newIssues: input.findings.length,
      regressionCandidates: [],
    };
  };
  const deps: MentorTickDeps = {
    framework: 'codex-cli',
    mode: 'live',
    surface: { framework: 'codex-cli', threadlineHistory: 'how is it going?' },
    safeWindowOpen: true,
    budgetOk: true,
    llmAvailable: true,
    spawnStageA: vi.fn(async () => 'Nice progress — ready for the next one?'),
    runStageBForensics: vi.fn(async () => []),
    capture,
    tickId: 'tick-1',
    ...over,
  };
  return { deps, captures };
}

describe('runMentorTick — gate order + structural guarantees', () => {
  it('halts and self-reports when the leak canary fails (dead-detector guard, §4.3)', async () => {
    const { deps, captures } = makeDeps({ canaryCheck: () => false });
    const r = await runMentorTick(deps);
    expect(r.ran).toBe(false);
    expect(r.reason).toBe('canary-failed');
    expect(deps.spawnStageA).not.toHaveBeenCalled();
    expect(captures[0].findings[0].signature).toBe('leak-canary-failed');
  });

  it('skips the entire tick under budget pressure BEFORE any spend/contact (fail-closed, §6)', async () => {
    const { deps, captures } = makeDeps({ budgetOk: false, canaryCheck: () => true });
    const r = await runMentorTick(deps);
    expect(r.reason).toBe('budget');
    expect(r.ran).toBe(false);
    expect(deps.spawnStageA).not.toHaveBeenCalled();
    expect(deps.runStageBForensics).not.toHaveBeenCalled();
    expect(captures).toHaveLength(0); // no contact, no capture
  });

  it('skips the tick when the LLM circuit is open (rate-limited) BEFORE any spend/spawn — does not re-trip the circuit', async () => {
    const { deps } = makeDeps({ llmAvailable: false, canaryCheck: () => true });
    const r = await runMentorTick(deps);
    expect(r.ran).toBe(false);
    expect(r.reason).toBe('llm-rate-limited');
    expect(deps.spawnStageA).not.toHaveBeenCalled();
    expect(deps.runStageBForensics).not.toHaveBeenCalled();
  });

  it('budget is checked BEFORE the llm-rate-limit gate (order)', async () => {
    const { deps } = makeDeps({ budgetOk: false, llmAvailable: false, canaryCheck: () => true });
    const r = await runMentorTick(deps);
    expect(r.reason).toBe('budget'); // budget wins the tie
  });

  it('skips when the safe window is closed (durable-state gate, §12 Q3)', async () => {
    const { deps } = makeDeps({ safeWindowOpen: false, canaryCheck: () => true });
    const r = await runMentorTick(deps);
    expect(r.reason).toBe('unsafe-window');
    expect(deps.spawnStageA).not.toHaveBeenCalled();
  });

  it('budget is checked BEFORE safe-window (order)', async () => {
    const { deps } = makeDeps({ budgetOk: false, safeWindowOpen: false, canaryCheck: () => true });
    const r = await runMentorTick(deps);
    expect(r.reason).toBe('budget'); // budget wins
  });

  it('happy path (clean transcript): runs, no leak, captures the run', async () => {
    const { deps, captures } = makeDeps({ canaryCheck: () => true });
    const r = await runMentorTick(deps);
    expect(r.ran).toBe(true);
    expect(r.reason).toBe('ran');
    expect(r.leakDetected).toBe(false);
    expect(deps.runStageBForensics).toHaveBeenCalled();
    // The run is captured even with zero findings (funnel/inert-writer guard).
    expect(captures).toHaveLength(1);
    expect(captures[0].findings).toHaveLength(0);
  });

  it('detects a Stage-A leak and captures it as an instar-integration-gap (§4.3)', async () => {
    const { deps, captures } = makeDeps({
      canaryCheck: () => true,
      spawnStageA: async () => 'you should fix src/messaging/Retry.ts:142 before PR #999',
    });
    const r = await runMentorTick(deps);
    expect(r.ran).toBe(true);
    expect(r.leakDetected).toBe(true);
    const f = captures[0].findings.find((x) => x.signature === 'stage-a-leak-suspected');
    expect(f).toBeTruthy();
    expect(f!.bucket).toBe('instar-integration-gap');
  });

  it('flows Stage-B findings through to capture', async () => {
    const { deps, captures } = makeDeps({
      canaryCheck: () => true,
      runStageBForensics: async () => [
        { bucket: 'framework-limitation', title: 'codex truncates long argv', dedupKey: 'codex::argv-trunc', severity: 'medium' },
      ],
    });
    const r = await runMentorTick(deps);
    expect(r.findingsCount).toBe(1);
    expect(captures[0].findings[0].dedupKey).toBe('codex::argv-trunc');
  });

  it('delivers to the mentee ONLY in live mode (never in dry-run) — §6', async () => {
    const deliver = vi.fn();
    const dry = makeDeps({ canaryCheck: () => true, mode: 'dry-run', deliverToMentee: deliver });
    const dryRes = await runMentorTick(dry.deps);
    expect(dryRes.ran).toBe(true);
    expect(dryRes.delivered).toBe(false);
    expect(deliver).not.toHaveBeenCalled(); // dry-run observes, never contacts

    const live = makeDeps({ canaryCheck: () => true, mode: 'live', deliverToMentee: deliver, spawnStageA: async () => 'next task: ship the X primitive' });
    const liveRes = await runMentorTick(live.deps);
    expect(liveRes.ran).toBe(true);
    expect(liveRes.delivered).toBe(true);
    expect(deliver).toHaveBeenCalledWith('codex-cli', 'next task: ship the X primitive');
  });

  it('does not deliver when there is no deliverToMentee wired (safe default)', async () => {
    const { deps } = makeDeps({ canaryCheck: () => true, mode: 'live', deliverToMentee: undefined });
    const r = await runMentorTick(deps);
    expect(r.delivered).toBe(false); // no path → no contact, no throw
  });

  it('on a Stage-A spawn failure, self-reports and does not run Stage B', async () => {
    const { deps, captures } = makeDeps({
      canaryCheck: () => true,
      spawnStageA: async () => { throw new Error('tmux spawn failed'); },
    });
    const r = await runMentorTick(deps);
    expect(r.ran).toBe(false);
    expect(r.reason).toBe('stage-a-failed');
    expect(deps.runStageBForensics).not.toHaveBeenCalled();
    expect(captures[0].findings[0].signature).toBe('stage-a-spawn-failed');
  });
});
