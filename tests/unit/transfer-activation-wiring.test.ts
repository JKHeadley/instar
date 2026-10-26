/**
 * Wiring integrity: the §L4 transfer-by-nickname path must have its pin store
 * wired at boot so an explicit `POST /pool/transfer` (the lever the agent calls
 * when the user asks to move a conversation) has a real store to pin into, and
 * so placement consults that pin. The planner (TransferByNickname) is a pure
 * unit; this pins that server.ts (1) constructs the pin store and (2) passes the
 * pin into SessionRouter.route() as topicMetadata so placement honors it.
 * Without these, the planner's pin is never consulted — the "constructed but
 * inert" failure the Testing Integrity Standard calls out.
 *
 * The server-side NL recognizer (MoveIntentClassifier + `_tryNicknameRelocation`)
 * was retired by docs/specs/retire-staged-features-2026-10-25.md: the agent
 * reads the conversation and drives the explicit route itself.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('server-boot wiring: transfer-by-nickname activation (§L4)', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

  it('constructs the TopicPlacementPinStore', () => {
    expect(src).toContain("import('../core/TopicPlacementPinStore.js')");
    expect(src).toContain('new pinMod.TopicPlacementPinStore(');
    // The keyword verb-list decision is GONE from the inbound path (the standard).
    expect(src).not.toContain('nickMod.recognizeNicknameCommand(');
  });

  it('no longer recognises a move phrase server-side (the agent calls POST /pool/transfer)', () => {
    expect(src).not.toContain("import('../core/MoveIntentClassifier.js')");
    expect(src).not.toContain('_tryNicknameRelocation');
    expect(src).not.toContain('classifyRelocationIntent(');
  });

  it('passes the pin into route() as topicMetadata so placement honors it', () => {
    const routeIdx = src.indexOf('await _sessionRouter.route({');
    expect(routeIdx).toBeGreaterThan(0);
    const block = src.slice(routeIdx, routeIdx + 480);
    // U4.1 §2D: seeding resolves local pin ⊕ fold winner by HLC when the fold is
    // wired (`_pinPlacementMetadata`), degrading to the plain local-store read —
    // both arms must stay present (the fallback IS today's behavior).
    expect(block).toContain('_pinPlacementMetadata ? _pinPlacementMetadata(String(topicId)) : _topicPinStore?.asTopicMetadata(String(topicId))');
  });
});
