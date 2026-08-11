/**
 * FUNNEL-level behavioural proof for the invisible-payload refusal.
 *
 * ── The defect this file exists for ────────────────────────────────────────────────────────────
 * The refusal was placed four times and its scope over-claimed four times, each over-claim
 * falsified by the next reader:
 *
 *   pass  9 → one HTTP route,         written up as "fixed at the point of sending"
 *   pass 27 → a 2nd route found;      guarded, written up as "both doors"
 *   pass 28 → a 3rd route found;      moved into sendToTopic, written up as
 *             "the single chokepoint every Telegram send passes through"
 *   pass 29 → falsified BY EXECUTION: `send()` — the MessagingAdapter INTERFACE method a router
 *             calls — reaches `apiCall('sendMessage')` without entering `sendToTopic` at all.
 *
 * Every previous test drove `sendToTopic` or a route, so every one of them stayed green while the
 * interface method sent an invisible payload. **This file drives `send()` first, deliberately.**
 *
 * ── What is asserted, and why each arm is here ─────────────────────────────────────────────────
 * Not "does something fail" — a broken guard and a working one both fail. Each arm asserts the
 * refusal fires FOR ITS OWN REASON, and every arm has a paired positive control, because a guard
 * that refuses everything is not a guard (review pass 21: a control that passes because it never
 * reaches what it guards is worse than none).
 *
 * The `fetch` stub is the load-bearing observation: it counts what actually left. Asserting only
 * that a promise rejected would pass if the send happened and the rejection came from somewhere
 * else — so every arm asserts the CALL COUNT, which is the thing a reader would actually receive.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import {
  assertTelegramPayloadVisible,
  setInvisiblePayloadRefusalSink,
  InvisiblePayloadRefusedError,
  BODY_CARRYING_TELEGRAM_METHODS,
  READER_VISIBLE_TELEGRAM_PARAMS,
} from '../../src/messaging/invisible-payload.js';

/** Payloads with nothing a reader can see. The incident was the first of these. */
const INVISIBLE = [
  '​',            // ZERO WIDTH SPACE — the live incident
  '',                  // empty
  '   ',               // whitespace only
  '‎⁡',      // LTR mark + function application
  '️­',      // variation selector + soft hyphen
  '\n\t ᠎',       // newline/tab/Mongolian vowel separator
];
/** Payloads a reader CAN see — the discrimination controls. */
const VISIBLE = ['.', 'hello', '0', '​x​'];

describe('invisible-payload refusal at the Telegram funnel', () => {
  let stateDir: string;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let adapter: TelegramAdapter;

  beforeEach(() => {
    // A fresh state dir per run: a shared one carries an outbound-dedup db across runs, and a
    // suppressed duplicate send reads exactly like a guard refusing. (Inherited from the route test.)
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-funnel-'));
    fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, result: { message_id: 1 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchSpy);
    adapter = new TelegramAdapter(
      { token: 'test-token', chatId: '-1001234567890' } as never,
      stateDir,
      { suppressLifelineAutoCreate: true },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(stateDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/telegram-send-funnel-invisible-payload.test.ts',
    });
  });

  // ── The arm that four previous placements all missed ─────────────────────────────────────────
  describe('send() — the interface method a router calls', () => {
    for (const payload of INVISIBLE) {
      it(`refuses ${JSON.stringify(payload)} and sends nothing`, async () => {
        await expect(
          adapter.send({ content: payload, channel: { identifier: '42' } } as never),
        ).rejects.toThrow(/no visible characters/i);
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    }

    for (const payload of VISIBLE) {
      it(`delivers ${JSON.stringify(payload)}`, async () => {
        await adapter.send({ content: payload, channel: { identifier: '42' } } as never);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
        expect(body.text).toBe(payload);
      });
    }
  });

  // ── The arm the previous placement covered, which must keep working ──────────────────────────
  describe('sendToTopic() — the previously-guarded path', () => {
    it('refuses a zero-width payload and sends nothing', async () => {
      await expect(adapter.sendToTopic(42, '​')).rejects.toThrow(/no visible characters/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('still delivers ordinary text', async () => {
      await adapter.sendToTopic(42, 'a real message');
      expect(fetchSpy).toHaveBeenCalled();
      const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
      expect(body.text).toBe('a real message');
    });
  });

  // ── EGRESS 2: the tokenless-standby relay, which never reaches apiCall ───────────────────────
  //
  // This block exists because an independent second-pass reviewer found that moving the refusal to
  // `apiCall` alone REMOVED coverage from this branch. When a pool standby's bot token arrives as an
  // unresolved placeholder, `sendToTopic` relays the body to the Telegram-owning router and returns
  // — `apiCall` is never entered. That is the FIFTH falsification of "every send passes through
  // here", found inside the change that retired the phrase, and no test in the repository drove
  // this branch, so nothing could have gone red.
  //
  // Relying on the far end is not sufficient and that is worth stating: the receiving route does
  // refuse an invisible body, but with a 400, while `isRelayRefusal` recognises only 422 — so the
  // refusal would surface to the caller as "relay failed … router unreachable", reporting a CONTENT
  // refusal as a TRANSPORT failure.
  describe('the tokenless-standby relay path', () => {
    function standbyAdapter() {
      const relay = vi.fn(async () => ({ messageId: 7 }));
      const a = new TelegramAdapter(
        // An unresolved externalized secret arrives as this truthy placeholder OBJECT, not null —
        // which is what makes the branch reachable in production (bug #7).
        { token: { secret: true } as never, chatId: '-1001234567890' } as never,
        stateDir,
        { suppressLifelineAutoCreate: true },
      );
      a.outboundRelay = relay as never;
      return { a, relay };
    }

    for (const payload of INVISIBLE) {
      it(`refuses ${JSON.stringify(payload)} without relaying it`, async () => {
        const { a, relay } = standbyAdapter();
        await expect(a.sendToTopic(42, payload)).rejects.toThrow(/no visible characters/i);
        expect(relay).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    }

    it('still relays ordinary text', async () => {
      const { a, relay } = standbyAdapter();
      await a.sendToTopic(42, 'a real message');
      expect(relay).toHaveBeenCalledTimes(1);
      expect(relay.mock.calls[0][1]).toBe('a real message');
    });

    it('reports a content refusal as a refusal, not as a transport failure', async () => {
      const { a } = standbyAdapter();
      // The distinction this asserts: the error must name the CONTENT problem. The relay's own
      // failure message ("router unreachable") would be a false diagnosis of a reachable router.
      await expect(a.sendToTopic(42, '​')).rejects.toThrow(/no visible characters/i);
      await expect(a.sendToTopic(42, '​')).rejects.not.toThrow(/router unreachable/i);
    });
  });


  // ── EGRESS 3: the lifeline's OWN funnel, in its own process ──────────────────────────────────
  //
  // Added on a round-4 convergence finding. The acceptance criterion claimed refusal at "every derived
  // egress, proven by input" while only the adapter's two egresses had path-level tests — the criterion
  // contradicted its own limits section. The lifeline is the sender whose complete absence of a guard was
  // this increment's headline discovery, so leaving it lint-covered-only was the weakest point in the set.
  describe('TelegramLifeline — its own private funnel', () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-'));
      fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify({
        agentName: 'test', stateDir: path.join(dir, '.instar', 'state'),
        messaging: [{ type: 'telegram', enabled: true, config: { token: 'test-token', chatId: '-100123' } }],
      }));
    });
    afterEach(() => {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true, force: true,
        operation: 'tests/unit/telegram-send-funnel-invisible-payload.test.ts',
      });
    });

    async function lifeline() {
      const { TelegramLifeline } = await import('../../src/lifeline/TelegramLifeline.js');
      return new TelegramLifeline(dir) as unknown as {
        sendToTopic(t: number, s: string): Promise<void>;
        apiCall(m: string, p: Record<string, unknown>): Promise<unknown>;
      };
    }

    it('refuses an invisible payload at its funnel and never reaches the network', async () => {
      const ll = await lifeline();
      await expect(ll.apiCall('sendMessage', { chat_id: 1, text: '​' }))
        .rejects.toThrow(/no visible characters/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('refuses through its own sendToTopic, the path every lifeline notice takes', async () => {
      const ll = await lifeline();
      // The lifeline's sendToTopic swallows send errors by design, so the observable proof that the
      // refusal fired is that NOTHING reached the network — asserting a throw here would test the
      // catch, not the guard.
      await ll.sendToTopic(42, '​​');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('still delivers ordinary text through the same path', async () => {
      const ll = await lifeline();
      await ll.sendToTopic(42, 'a real lifeline notice');
      expect(fetchSpy).toHaveBeenCalled();
      const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
      expect(body.text).toBe('a real lifeline notice');
    });
  });

  // ── The over-refusal boundary ────────────────────────────────────────────────────────────────
  // A guard that refuses more than it claims is still a defect (pass 28 recorded exactly that
  // class). `answerCallbackQuery` carries a `text` param, renders a transient toast, and an empty
  // one legitimately just dismisses the spinner — so it is deliberately outside the population.
  describe('methods that carry no reader-visible body are NOT refused', () => {
    it('leaves answerCallbackQuery with empty text alone', () => {
      expect(() => assertTelegramPayloadVisible('answerCallbackQuery', { text: '' })).not.toThrow();
    });

    it('leaves a bodyless method alone', () => {
      expect(() => assertTelegramPayloadVisible('sendChatAction', { action: 'typing' })).not.toThrow();
    });

    it('refuses an invisible editMessageText, which DOES replace a body a reader reads', () => {
      expect(() => assertTelegramPayloadVisible('editMessageText', { text: '​' }))
        .toThrow(/no visible characters/i);
    });
  });

  // ── Unicode-table divergence: the boundary code points, pinned ───────────────────────────────
  //
  // Added on a round-5 convergence finding. The invisible classes resolve through the host engine's
  // Unicode tables, and the fleet demonstrably spans versions (engines floor is >=20.12.0, CI runs Node
  // 20, this machine runs Node 24) — so "every machine reaches the same verdict" was an assumption with
  // nothing testing it. These fixtures pin the classification of the boundary code points on WHATEVER
  // engine runs them: the same file red-flags a divergence on Node 20 and on Node 24 rather than each
  // silently believing itself correct.
  describe('boundary code points classify identically on the running engine', () => {
    const INVISIBLE_POINTS: Array<[string, string]> = [
      ['U+200B ZERO WIDTH SPACE', '\u200b'],
      ['U+200E LEFT-TO-RIGHT MARK', '\u200e'],
      ['U+2061 FUNCTION APPLICATION', '\u2061'],
      ['U+FE0F VARIATION SELECTOR-16', '\ufe0f'],
      ['U+00AD SOFT HYPHEN', '\u00ad'],
      ['U+180E MONGOLIAN VOWEL SEPARATOR', '\u180e'],
      ['U+2060 WORD JOINER', '\u2060'],
      ['U+FEFF ZERO WIDTH NO-BREAK SPACE', '\ufeff'],
    ];
    // Non-printing categories the SUBTRACTIVE predicate let through, proven by execution before the
    // positive definition replaced it. Each would have been delivered and rendered as nothing or tofu.
    const NON_PRINTING_POINTS: Array<[string, string]> = [
      ['Cc U+0001 START OF HEADING', '\u0001'],
      ['Cc U+0007 BELL', '\u0007'],
      ['Cc U+001B ESCAPE', '\u001b'],
      ['Cn U+0378 unassigned', '\u0378'],
      ['Co U+E000 private use', '\ue000'],
      ['noncharacter U+FFFE', '\ufffe'],
      ['Cs U+D800 lone surrogate', '\ud800'],
    ];
    const VISIBLE_POINTS: Array<[string, string]> = [
      ['U+002E FULL STOP', '.'],
      ['a base letter carrying a combining acute', 'e\u0301'],
      ['a letter beside an ideographic space', 'x\u3000'],
      ['U+1F600 GRINNING FACE', '\u{1F600}'],
      ['a digit', '7'],
      // Corrected at review pass 30: excluding ALL marks over-refused real text. Mc and Me are graphic
      // and carry advance width — a reader sees them — so a payload made of them is content.
      // Review pass 31 measured my advance-width rationale false — Mn U+20D0 advances 18.4 on this host,
      // re-measured independently before conceding. All marks are graphic and are content; the split is gone.
      ['Mn U+0301 lone combining acute', '\u0301'],
      ['Mn U+20D0 COMBINING LEFT HARPOON ABOVE', '\u20d0'],
      ['Mc U+0903 DEVANAGARI SIGN VISARGA (spacing mark)', '\u0903'],
      ['Me U+20DD COMBINING ENCLOSING CIRCLE (enclosing mark)', '\u20dd'],
      ['a Devanagari letter carrying its visarga', '\u0915\u0903'],
    ];

    for (const [name, ch] of INVISIBLE_POINTS) {
      it(`refuses ${name} alone`, () => {
        expect(() => assertTelegramPayloadVisible('sendMessage', { text: ch }))
          .toThrow(/no visible characters/i);
      });
    }
    // Category-positive but visually blank — the POSITIVE predicate's own false positives, found at
    // convergence round 10 and confirmed by execution before the fix. Each is a letter or symbol by
    // General_Category and renders as empty space.
    const BLANK_GLYPH_POINTS: Array<[string, string]> = [
      ['U+3164 HANGUL FILLER (Lo)', '\u3164'],
      ['U+115F HANGUL CHOSEONG FILLER (Lo)', '\u115f'],
      ['U+1160 HANGUL JUNGSEONG FILLER (Lo)', '\u1160'],
      ['U+FFA0 HALFWIDTH HANGUL FILLER (Lo)', '\uffa0'],
      ['U+2800 BRAILLE PATTERN BLANK (So)', '\u2800'],
    ];
    for (const [name, ch] of BLANK_GLYPH_POINTS) {
      it(`refuses ${name} — category-positive, renders blank`, () => {
        expect(() => assertTelegramPayloadVisible('sendMessage', { text: ch }))
          .toThrow(/no visible characters/i);
      });
    }
    it('accepts a blank glyph when real content sits beside it', () => {
      expect(() => assertTelegramPayloadVisible('sendMessage', { text: 'hi\u3164' })).not.toThrow();
    });

    for (const [name, ch] of NON_PRINTING_POINTS) {
      it(`refuses ${name} alone — the subtractive predicate delivered every one of these`, () => {
        expect(() => assertTelegramPayloadVisible('sendMessage', { text: ch }))
          .toThrow(/no visible characters/i);
      });
    }
    for (const [name, ch] of VISIBLE_POINTS) {
      it(`accepts ${name}`, () => {
        expect(() => assertTelegramPayloadVisible('sendMessage', { text: ch })).not.toThrow();
      });
    }

    it('records the engine it was proven on, so a divergence is attributable', () => {
      // Not an assertion about WHICH version — an assertion that the version is knowable from the run.
      expect(process.versions.unicode ?? process.version).toBeTruthy();
    });
  });

  // ── Structured decision logging — the requirement, met and tested ───────────────────────────
  //
  // docs/signal-vs-authority.md: "Authorities must log their decisions in a structured form: which
  // signals they received, what the conversation context was, which rule they applied, and what the
  // outcome was." This guard is blocking authority and logged NOTHING. Raised at convergence round 4,
  // not acted on, raised again at round 11 — so these tests exist to make the omission impossible to
  // repeat silently.
  describe('every refusal emits a structured decision', () => {
    it('records method, field, rule, outcome and the deciding engine', () => {
      const seen: unknown[] = [];
      const prev = setInvisiblePayloadRefusalSink((d) => seen.push(d));
      try {
        expect(() => assertTelegramPayloadVisible('sendMessage', { text: '\u200b' })).toThrow();
      } finally {
        setInvisiblePayloadRefusalSink(prev);
      }
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        guard: 'invisible-payload',
        outcome: 'refused',
        method: 'sendMessage',
        field: 'text',
        rule: 'no-content-codepoint',
        valueLength: 1,
      });
    });

    it('never puts the payload itself in the record — length only', () => {
      const seen: Array<Record<string, unknown>> = [];
      const prev = setInvisiblePayloadRefusalSink((d) => seen.push(d as never));
      try {
        expect(() => assertTelegramPayloadVisible('createForumTopic', { name: '\u3164\u3164' })).toThrow();
      } finally {
        setInvisiblePayloadRefusalSink(prev);
      }
      const record = JSON.stringify(seen[0]);
      expect(record).not.toContain('\u3164');
      expect(seen[0]).toMatchObject({ method: 'createForumTopic', field: 'name', valueLength: 2 });
    });

    it('carries the decision on the error too, so a catcher can record it', () => {
      try {
        assertTelegramPayloadVisible('sendMessage', { text: '   ' });
        throw new Error('should have refused');
      } catch (e) {
        expect(e).toBeInstanceOf(InvisiblePayloadRefusedError);
        expect((e as InvisiblePayloadRefusedError).decision.rule).toBe('no-content-codepoint');
      }
    });

    it('a THROWING sink still refuses — a broken audit trail never becomes a delivery', () => {
      const prev = setInvisiblePayloadRefusalSink(() => { throw new Error('sink is down'); });
      try {
        expect(() => assertTelegramPayloadVisible('sendMessage', { text: '\u200b' }))
          .toThrow(/no visible characters/i);
      } finally {
        setInvisiblePayloadRefusalSink(prev);
      }
    });

    // ONE OPERATION, ONE RECORD — review pass 30 finding 2. The existing arms asserted network
    // suppression and never asserted the record COUNT, so a refusal that was logged, caught by a
    // bare retry, re-attempted and logged again read as correct. Two records for one refused
    // operation turns the observability stream into an attempt counter, which is exactly the kind of
    // instrument this window keeps convicting.
    it('emits exactly ONE record per refused operation, not one per attempt', async () => {
      const seen: unknown[] = [];
      const prev = setInvisiblePayloadRefusalSink((d) => seen.push(d));
      try {
        await expect(adapter.sendToTopic(42, '\u200b')).rejects.toThrow(/no visible characters/i);
      } finally {
        setInvisiblePayloadRefusalSink(prev);
      }
      expect(seen, 'a refusal was logged, retried and logged again').toHaveLength(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('emits exactly ONE record when send() refuses, across its own retry path', async () => {
      const seen: unknown[] = [];
      const prev = setInvisiblePayloadRefusalSink((d) => seen.push(d));
      try {
        await expect(
          adapter.send({ content: '\u200b', channel: { identifier: '42' } } as never),
        ).rejects.toThrow(/no visible characters/i);
      } finally {
        setInvisiblePayloadRefusalSink(prev);
      }
      expect(seen).toHaveLength(1);
    });

    it('emits nothing when the payload is fine', () => {
      const seen: unknown[] = [];
      const prev = setInvisiblePayloadRefusalSink((d) => seen.push(d));
      try {
        assertTelegramPayloadVisible('sendMessage', { text: 'hello' });
      } finally {
        setInvisiblePayloadRefusalSink(prev);
      }
      expect(seen).toHaveLength(0);
    });
  });

  // ── The population itself ────────────────────────────────────────────────────────────────────
  describe('the body-carrying method set', () => {
    it('is exactly the methods carrying a reader-visible field, each with its field named', () => {
      // Pinned, because silently widening it would start refusing toasts and silently narrowing it
      // would re-open the hole. A deliberate change to the map must change this line too.
      expect(READER_VISIBLE_TELEGRAM_PARAMS).toEqual({
        sendMessage: 'text',
        editMessageText: 'text',
        createForumTopic: 'name',
        editForumTopic: 'name',
      });
    });

    it('derives the method-name set from the map, so the two cannot disagree', () => {
      expect([...BODY_CARRYING_TELEGRAM_METHODS].sort())
        .toEqual(Object.keys(READER_VISIBLE_TELEGRAM_PARAMS).sort());
    });

    it('refuses an invisible forum-topic NAME, which trim-length validation lets through', () => {
      // The route guard is `name.trim().length >= 1`, and trim() does not remove zero-width
      // characters — they are format controls, not whitespace — so two ZWSPs measure 2 and pass.
      expect('\u200b\u200b'.trim().length).toBe(2);
      expect(() => assertTelegramPayloadVisible('createForumTopic', { name: '\u200b\u200b' }))
        .toThrow(/no visible characters/i);
      expect(() => assertTelegramPayloadVisible('editForumTopic', { name: '\u200b' }))
        .toThrow(/no visible characters/i);
    });

    it('leaves a real topic name alone, and ignores the text field on a name-carrying method', () => {
      expect(() => assertTelegramPayloadVisible('createForumTopic', { name: 'Lifeline' })).not.toThrow();
      // createForumTopic is keyed on `name`; an unrelated `text` key must not be consulted.
      expect(() => assertTelegramPayloadVisible('createForumTopic', { name: 'ok', text: '\u200b' }))
        .not.toThrow();
    });

    it('ignores a non-string text rather than throwing on it', () => {
      expect(() => assertTelegramPayloadVisible('sendMessage', { text: undefined })).not.toThrow();
      expect(() => assertTelegramPayloadVisible('sendMessage', {})).not.toThrow();
    });
  });
});
