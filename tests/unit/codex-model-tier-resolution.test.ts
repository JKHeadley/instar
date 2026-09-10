/**
 * Codex model-tier resolution + retired-model regression guard.
 *
 * Context: OpenAI has now retired codex model ids from the ChatGPT-account
 * surface THREE times — the `-codex` suffixed names (2026-04-14), `gpt-5.2`
 * (2026-06-03) and the whole gpt-5.4/5.5 generation (2026-09-09). Each time,
 * the two hardcoded codex tier maps — the adapter resolver
 * (openai-codex/models.ts) and the session-launch resolver
 * (frameworkSessionLaunch.ts) — kept pointing at a dead id, which silently
 * broke EVERY internal codex call (sentinels, gates, reflectors) on every
 * codex agent.
 *
 * The 2026-09-09 sweep was worse than its predecessors because it also killed
 * `CODEX_CHATGPT_FALLBACK_MODEL`, the floor the retirement self-heal retries
 * onto — so the self-heal swapped one rejected model for another and the fleet
 * stayed dark. These tests pin the live mapping, pin the floor to a live id,
 * and guard EVERY retired name so a future edit can't reintroduce one.
 *
 * Model ids here are live-probed, never guessed. Probe of 2026-09-09 against
 * the ChatGPT subscription: gpt-5.6-sol and gpt-6-astra answered; gpt-5.4-mini,
 * gpt-5.4, gpt-5.6, gpt-6, gpt-5.6-mini and gpt-6-mini returned 400 "not
 * supported when using Codex with a ChatGPT account"; gpt-5.5 returned 404.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveCliModelFlag,
  CODEX_CHATGPT_FALLBACK_MODEL,
} from '../../src/providers/adapters/openai-codex/models.js';
import { resolveModelForFramework } from '../../src/core/frameworkSessionLaunch.js';
import { KNOWN_CODEX_MODEL_IDS } from '../../src/core/ModelTierEscalation.js';

/** Every codex id observed REJECTED on the ChatGPT-account surface, with the date. */
const RETIRED_ON_CHATGPT_ACCOUNT = [
  'gpt-5.2',        // 2026-06-03
  'gpt-5.4',        // 2026-09-09
  'gpt-5.4-mini',   // 2026-09-09 — was both the fast/balanced tier AND the floor
  'gpt-5.5',        // 2026-09-09 (404, not 400)
];

const LIGHT = 'gpt-5.6-sol';
const HEAVY = 'gpt-6-astra';
/** The canonical tiers BOTH resolvers understand. */
const GENERIC_TIERS = ['fast', 'balanced', 'capable'];
/**
 * Claude-style aliases. Only the SESSION-LAUNCH resolver translates these; the
 * adapter resolver documents that an unrecognised string passes through
 * verbatim (it is a tier-or-raw-model-name resolver), so asserting a
 * translation there would pin behaviour the adapter never promised.
 */
const CLAUDE_ALIASES = ['haiku', 'sonnet', 'opus'];
const ALL_LAUNCH_TIERS = [...GENERIC_TIERS, ...CLAUDE_ALIASES];

describe('codex model-tier resolution (post 2026-09-09 gpt-5.4/5.5 retirement)', () => {
  describe('adapter resolver — resolveCliModelFlag (intel / one-shot path)', () => {
    it('fast tier resolves to the cheapest still-accepted model', () => {
      expect(resolveCliModelFlag('fast')).toBe(LIGHT);
    });
    it('balanced tier resolves to the same light model (no non-reasoning option exists)', () => {
      expect(resolveCliModelFlag('balanced')).toBe(LIGHT);
    });
    it('capable tier resolves to the live frontier model', () => {
      expect(resolveCliModelFlag('capable')).toBe(HEAVY);
    });
    it('undefined falls back to the balanced default', () => {
      expect(resolveCliModelFlag(undefined)).toBe(LIGHT);
    });
    it('a raw model id passes through verbatim', () => {
      expect(resolveCliModelFlag('gpt-6-astra')).toBe('gpt-6-astra');
    });
  });

  describe('session-launch resolver — resolveModelForFramework(codex-cli, ...)', () => {
    it('fast tier resolves to the light model', () => {
      expect(resolveModelForFramework('codex-cli', 'fast')).toBe(LIGHT);
    });
    it('legacy haiku alias resolves to the light model (not a retired id)', () => {
      expect(resolveModelForFramework('codex-cli', 'haiku')).toBe(LIGHT);
    });
    it('balanced maps light and capable maps heavy', () => {
      expect(resolveModelForFramework('codex-cli', 'balanced')).toBe(LIGHT);
      expect(resolveModelForFramework('codex-cli', 'capable')).toBe(HEAVY);
    });
    it('legacy opus alias resolves to the live frontier model', () => {
      expect(resolveModelForFramework('codex-cli', 'opus')).toBe(HEAVY);
    });
  });

  describe('retirement safety floor', () => {
    it('the floor the self-heal retries onto is NOT itself a retired id', () => {
      // The 2026-09-09 outage: floor was gpt-5.4-mini, retired in the same
      // sweep, so the self-heal retried one dead model with another.
      expect(RETIRED_ON_CHATGPT_ACCOUNT).not.toContain(CODEX_CHATGPT_FALLBACK_MODEL);
    });
    it('the floor is an id the retry authority will actually accept', () => {
      // CodexCliIntelligenceProvider gates the retry on this membership test;
      // a floor outside the known set silently disables the self-heal.
      expect(KNOWN_CODEX_MODEL_IDS as readonly string[]).toContain(CODEX_CHATGPT_FALLBACK_MODEL);
    });
  });

  describe('retired-model regression guard', () => {
    it('NO tier in EITHER resolver produces ANY retired id', () => {
      for (const tier of GENERIC_TIERS) {
        expect(RETIRED_ON_CHATGPT_ACCOUNT).not.toContain(resolveCliModelFlag(tier));
      }
      for (const tier of ALL_LAUNCH_TIERS) {
        expect(RETIRED_ON_CHATGPT_ACCOUNT).not.toContain(
          resolveModelForFramework('codex-cli', tier),
        );
      }
      expect(RETIRED_ON_CHATGPT_ACCOUNT).not.toContain(resolveCliModelFlag(undefined));
    });
    it('every tier resolves to an id the spawn route and pin validator accept', () => {
      // Both surfaces validate against KNOWN_CODEX_MODEL_IDS. A tier that
      // resolves outside it is rejected before the call is ever made.
      for (const tier of GENERIC_TIERS) {
        expect(KNOWN_CODEX_MODEL_IDS as readonly string[]).toContain(resolveCliModelFlag(tier));
      }
      for (const tier of ALL_LAUNCH_TIERS) {
        expect(KNOWN_CODEX_MODEL_IDS as readonly string[]).toContain(
          resolveModelForFramework('codex-cli', tier),
        );
      }
    });
  });
});
