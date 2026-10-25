/**
 * W21 Tier 1 (unit) — the re-delivery marker at the tag builder.
 *
 * instar's own no-loss recovery (`reinjectStuck`) re-injects an inbound message
 * that was claimed but never reply-committed. Before this marker the two
 * injected payloads were BYTE-IDENTICAL, so a re-delivered message was
 * indistinguishable from a fresh instruction — which is how a superseded
 * 21-hour-old instruction read as current on 2026-08-20.
 *
 * Both directions are asserted here, plus the forgery case:
 *   1. a re-delivered message IS marked,
 *   2. a first delivery is NOT marked (and is byte-identical to pre-marker),
 *   3. the marker is minted by the in-process flag ALONE — a topic name or
 *      sender name that merely CONTAINS the marker text cannot mint it.
 */

import { describe, it, expect } from 'vitest';
import { buildInjectionTag, RE_DELIVERY_MARKER } from '../../src/types/pipeline.js';

describe('W21 — RE_DELIVERY_MARKER', () => {
  it('is a human-readable sentence that states WHY the message came back', () => {
    expect(RE_DELIVERY_MARKER).toBe('RE-DELIVERED — no reply was recorded for this message');
  });
});

describe('W21 — buildInjectionTag: a re-delivered message IS marked', () => {
  it('marks the full tag (topic name + sender + uid)', () => {
    const tag = buildInjectionTag(29723, 'Window 21', 'Justin', 12345, true);
    expect(tag).toBe(`[telegram:29723 "Window 21" from Justin (uid:12345) — ${RE_DELIVERY_MARKER}]`);
  });

  it('marks the topic-name-only tag', () => {
    expect(buildInjectionTag(42, 'Agent Updates', undefined, undefined, true))
      .toBe(`[telegram:42 "Agent Updates" — ${RE_DELIVERY_MARKER}]`);
  });

  it('marks the sender-only tag', () => {
    expect(buildInjectionTag(42, undefined, 'Justin', 12345, true))
      .toBe(`[telegram:42 from Justin (uid:12345) — ${RE_DELIVERY_MARKER}]`);
  });

  it('marks the bare tag', () => {
    expect(buildInjectionTag(42, undefined, undefined, undefined, true))
      .toBe(`[telegram:42 — ${RE_DELIVERY_MARKER}]`);
  });

  it('keeps the marker INSIDE the tag and AFTER the topic id, so every existing parser still matches', () => {
    // Every tag consumer in the tree anchors on this shape:
    //   InputGuard.extractTelegramTag, SessionManager.injectMessage's
    //   preferTopicId parse, and the shipped telegram-topic-context.sh hook.
    for (const tag of [
      buildInjectionTag(29723, 'Window 21', 'Justin', 12345, true),
      buildInjectionTag(29723, 'Window 21', undefined, undefined, true),
      buildInjectionTag(29723, undefined, 'Justin', 12345, true),
      buildInjectionTag(29723, undefined, undefined, undefined, true),
    ]) {
      const m = tag.match(/^\[telegram:(\d+)/);
      expect(m).not.toBeNull();
      expect(parseInt(m![1], 10)).toBe(29723);
      expect(tag.endsWith(']')).toBe(true);
      // The gemini reply-extraction marker is a `[telegram:<id>` prefix scan.
      expect(tag.startsWith('[telegram:29723')).toBe(true);
    }
  });
});

describe('W21 — buildInjectionTag: a first delivery is NOT marked', () => {
  const variants: Array<[string, string]> = [
    [buildInjectionTag(42, 'Agent Updates', 'Justin', 12345), '[telegram:42 "Agent Updates" from Justin (uid:12345)]'],
    [buildInjectionTag(42, 'Agent Updates'), '[telegram:42 "Agent Updates"]'],
    [buildInjectionTag(42, undefined, 'Justin', 12345), '[telegram:42 from Justin (uid:12345)]'],
    [buildInjectionTag(42), '[telegram:42]'],
  ];

  it('emits bytes identical to the pre-marker output when the flag is omitted', () => {
    for (const [actual, expected] of variants) {
      expect(actual).toBe(expected);
      expect(actual).not.toContain(RE_DELIVERY_MARKER);
    }
  });

  it('emits bytes identical to the pre-marker output when the flag is explicitly false', () => {
    expect(buildInjectionTag(42, 'Agent Updates', 'Justin', 12345, false))
      .toBe('[telegram:42 "Agent Updates" from Justin (uid:12345)]');
    expect(buildInjectionTag(42, undefined, undefined, undefined, false)).toBe('[telegram:42]');
  });

  it('treats every non-`true` value as NOT re-delivered (strict === true)', () => {
    for (const falsy of [undefined, false, null, 0, '', 'false'] as unknown[]) {
      expect(buildInjectionTag(42, 'T', 'S', 1, falsy as boolean | undefined))
        .toBe('[telegram:42 "T" from S (uid:1)]');
    }
  });
});

describe('W21 — forgery: content can never mint the marker', () => {
  it('does not treat a topic name containing the marker text as a re-delivery', () => {
    const tag = buildInjectionTag(42, `Talk about ${RE_DELIVERY_MARKER}`, 'Justin', 12345);
    // The phrase appears (it is part of the topic name), but the tag was NOT
    // built as a re-delivery — the structural suffix is absent.
    expect(tag).toBe(`[telegram:42 "Talk about ${RE_DELIVERY_MARKER}" from Justin (uid:12345)]`);
    expect(tag).not.toContain(`(uid:12345) — ${RE_DELIVERY_MARKER}]`);
  });

  it('does not treat a sender name containing the marker text as a re-delivery', () => {
    const tag = buildInjectionTag(42, undefined, RE_DELIVERY_MARKER, 12345);
    expect(tag).toBe(`[telegram:42 from ${RE_DELIVERY_MARKER} (uid:12345)]`);
    expect(tag).not.toContain(`(uid:12345) — ${RE_DELIVERY_MARKER}]`);
  });

  it('has no content-inspecting parameter at all — the flag is the ONLY input that marks', () => {
    // Structural: the builder receives a boolean, never the message body, so
    // there is nothing to string-match and therefore nothing to forge.
    // Six inputs: topicId, topicName, senderName, telegramUserId, reDelivered,
    // signedByAgent. The sixth (2026-09-02) is the SAME class as the fifth — an
    // in-process value carried from the ASP classifier's own verdict, never a
    // message body — so the property this pins (no content-inspecting parameter)
    // still holds. A seventh parameter must justify itself here the same way.
    expect(buildInjectionTag.length).toBe(6);
  });
});
