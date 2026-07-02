/**
 * Wiring integrity: the §L4 transfer-by-nickname activation must be wired into
 * the inbound path so "move/run this on <nickname>" actually relocates a session.
 * The recognizer (NicknameCommand) + planner (TransferByNickname) are pure units;
 * this pins that server.ts (1) constructs the pin store, (2) recognizes the
 * command on inbound and applies the plan (set pin + release local ownership),
 * (3) passes the pin into SessionRouter.route() as topicMetadata so placement
 * honors it, and (4) gates the whole thing on stage !== 'dark'. Without these,
 * the recognizer/planner have no caller and a pin is never consulted — the
 * "constructed but inert" failure the Testing Integrity Standard calls out.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('server-boot wiring: transfer-by-nickname activation (§L4)', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

  it('constructs the TopicPlacementPinStore + recognizer/planner imports', () => {
    expect(src).toContain("import('../core/TopicPlacementPinStore.js')");
    expect(src).toContain('new pinMod.TopicPlacementPinStore(');
    expect(src).toContain("import('../core/NicknameCommand.js')");
    expect(src).toContain("import('../core/TransferByNickname.js')");
  });

  it('recognizes the command on inbound + plans the transfer (recognizer → planner)', () => {
    expect(src).toContain('nickMod.recognizeNicknameCommand(text, knownNicknames)');
    expect(src).toContain('transferMod.planTransferByNickname(');
  });

  it('applies a transfer plan: sets the pin AND releases local ownership so it re-places', () => {
    const idx = src.indexOf('transferMod.planTransferByNickname(');
    // Window 4800 (was 3600): U4.1 §2B replaced the raw `_topicPinStore!.set(...)`
    // with the ONE-HLC mutation funnel (`pinMutationMod.setPinWithOneHlc` — the
    // same stamp on the replicated PUT and the local set) + §2F pinnedBy
    // provenance resolution, growing the arm; the release CAS follows it.
    const block = src.slice(idx, idx + 4800);
    expect(block).toContain('pinMutationMod.setPinWithOneHlc(');
    expect(block).toContain('_topicPinStore!'); // the funnel writes THROUGH the real local store
    expect(block).toContain("type: 'release'"); // release local ownership so route() re-places to the pin
  });

  it('intercepts the relocation BEFORE route() and returns when handled (command not also dispatched)', () => {
    const reloIdx = src.indexOf('_tryNicknameRelocation && _sessionPoolStage() !== ');
    const routeIdx = src.indexOf('await _sessionRouter.route({');
    expect(reloIdx).toBeGreaterThan(0);
    expect(routeIdx).toBeGreaterThan(reloIdx); // relocation check comes first
    const block = src.slice(reloIdx, reloIdx + 320);
    expect(block).toContain('if (relo.handled) return');
  });

  it('passes the pin into route() as topicMetadata so placement honors it', () => {
    const routeIdx = src.indexOf('await _sessionRouter.route({');
    const block = src.slice(routeIdx, routeIdx + 480);
    // U4.1 §2D: seeding resolves local pin ⊕ fold winner by HLC when the fold is
    // wired (`_pinPlacementMetadata`), degrading to the plain local-store read —
    // both arms must stay present (the fallback IS today's behavior).
    expect(block).toContain('_pinPlacementMetadata ? _pinPlacementMetadata(String(topicId)) : _topicPinStore?.asTopicMetadata(String(topicId))');
  });

  it('is dark-gated (the relocation only fires when the rollout stage is past dark)', () => {
    expect(src).toContain("_tryNicknameRelocation && _sessionPoolStage() !== 'dark'");
  });
});
