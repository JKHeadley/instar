/**
 * Integration: the inbound move-intent path end-to-end — classifier → planner.
 *
 * `_tryNicknameRelocation` (server.ts §L4) runs exactly this chain:
 *   classifyRelocationIntent → toNicknameCommand → planTransferByNickname.
 * This test composes those real units (no server spawn) to prove the DECISION
 * flows into the right ACTION: a genuine command yields a transfer plan to the
 * resolved machine; discussion / fail-open yields no plan (the message would
 * pass through to the agent); and the dry-run gate withholds action while still
 * classifying. It is the regression guard for the exact 2026-07-03 hijack.
 */
import { describe, it, expect } from 'vitest';
import { classifyRelocationIntent, toNicknameCommand } from '../../src/core/MoveIntentClassifier.js';
import { planTransferByNickname, type TransferByNicknameState } from '../../src/core/TransferByNickname.js';
import { buildRelocationNicknameSet } from '../../src/core/RelocationNicknameSet.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

// Two real machines, resolved through the real RelocationNicknameSet resolver.
const CAPS = [
  { machineId: 'm_mini', nickname: 'mini' },
  { machineId: 'm_laptop', nickname: 'laptop' },
];
const { knownNicknames, nickToMachine } = buildRelocationNicknameSet({
  capacities: CAPS,
  selfMachineId: 'm_laptop',
  selfNickname: 'laptop',
});

function plannerState(over: Partial<TransferByNicknameState> = {}): TransferByNicknameState {
  return {
    resolveNickname: (n) => nickToMachine.get(n.toLowerCase()) ?? null,
    validNicknames: () => knownNicknames,
    isOnline: () => true,
    currentOwnerOf: () => 'm_laptop', // we currently own the topic
    isMidReply: () => false,
    lastPlacementUpdateAt: () => null,
    now: () => 1_000_000,
    ...over,
  };
}

function stub(raw: string): IntelligenceProvider {
  return { evaluate: async () => raw };
}
function verdict(o: object): string { return JSON.stringify(o); }

/** Mirror of the wiring's decision: act only on a command AND not in dry-run. */
async function relocationDecision(text: string, intelligence: IntelligenceProvider, dryRun: boolean) {
  const result = await classifyRelocationIntent({ text, knownNicknames, intelligence, minConfidence: 0.85 });
  const willAct = result.isCommand && !dryRun;
  if (!willAct) return { handled: false as const, result };
  const cmd = toNicknameCommand(result);
  if (!cmd) return { handled: false as const, result };
  const plan = planTransferByNickname(cmd, plannerState(), 'topic-42');
  return { handled: true as const, result, plan };
}

describe('inbound move-intent path — decision → action', () => {
  it('a real command relocates: classifier → command → transfer plan to the resolved machine', async () => {
    const provider = stub(verdict({ isCommand: true, intent: 'transfer', targetNickname: 'mini', confidence: 0.96 }));
    const out = await relocationDecision('move this to the mini', provider, /* dryRun */ false);
    expect(out.handled).toBe(true);
    expect(out.plan!.action).toBe('transfer');
    expect(out.plan!.targetMachine).toBe('m_mini');
    expect(out.plan!.setPin).toBe(true);
  });

  it('THE HIJACK REGRESSION: "keep the work on the laptop" is discussion → NOT handled (message passes through)', async () => {
    const provider = stub(verdict({ isCommand: false, confidence: 0.92 }));
    const out = await relocationDecision('keep the work on the laptop', provider, /* dryRun */ false);
    expect(out.handled).toBe(false); // the exact message that was swallowed now reaches the agent
    expect(out.result.isCommand).toBe(false);
  });

  it('a question is discussion → NOT handled', async () => {
    const provider = stub(verdict({ isCommand: false, confidence: 0.88 }));
    const out = await relocationDecision('should we move this to the mini?', provider, false);
    expect(out.handled).toBe(false);
  });

  it('FAIL-OPEN: provider down → NOT handled (never hijack under uncertainty)', async () => {
    const provider: IntelligenceProvider = { evaluate: async () => { throw new Error('down'); } };
    const out = await relocationDecision('move this to the mini', provider, false);
    expect(out.handled).toBe(false);
    expect(out.result.source).toBe('fail-open');
  });

  it('DRY-RUN: a real command is classified as a command but NOT acted on (soak)', async () => {
    const provider = stub(verdict({ isCommand: true, intent: 'transfer', targetNickname: 'mini', confidence: 0.96 }));
    const out = await relocationDecision('move this to the mini', provider, /* dryRun */ true);
    expect(out.result.isCommand).toBe(true); // would-hijack recorded
    expect(out.handled).toBe(false);          // but the message passes through
  });

  it('GUARDRAIL: unknown machine → NOT handled even though the model claimed a command', async () => {
    const provider = stub(verdict({ isCommand: true, intent: 'transfer', targetNickname: 'toaster', confidence: 0.99 }));
    const out = await relocationDecision('move this to the toaster', provider, false);
    expect(out.handled).toBe(false); // no known machine named → no relocation
    expect(out.result.isCommand).toBe(false);
  });
});
