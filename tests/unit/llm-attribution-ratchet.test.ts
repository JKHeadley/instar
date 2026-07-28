/**
 * Attribution ratchet + lint self-test + componentCategories wiring test
 * (token-audit-completeness, Slice 3).
 *
 * Pins THREE lists: the violations allowlist (= EMPTY baseline), the
 * FUNNEL_FILES exemption class, and the wiring-test exclusions. Additions to
 * ANY of them fail CI pointing at the Token-Audit Completeness standard
 * (docs/STANDARDS-REGISTRY.md) — an unpinned exemption surface would be
 * exactly the dodge channel the ratchet exists to close.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VIOLATIONS_ALLOWLIST,
  FUNNEL_FILES,
  checkFileText,
  stripComments,
  isOutOfScope,
  runLint,
  // eslint-disable-next-line import/no-relative-packages
} from '../../scripts/lint-llm-attribution.js';
import { categoryForComponent } from '../../src/core/componentCategories.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function walkSrc(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name)) out.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  return out;
}

describe('ratchet — the three pinned lists', () => {
  it('violations allowlist is the EMPTY baseline (any addition fails CI)', () => {
    // Token-Audit Completeness standard: the baseline was driven to zero in
    // the PR that added this lint. New funnel callsites must inline
    // attribution — never allowlist. See docs/STANDARDS-REGISTRY.md.
    expect(Array.from(VIOLATIONS_ALLOWLIST)).toEqual([]);
  });

  it('FUNNEL_FILES is pinned to the known funnel forwarders + provider implementations', () => {
    expect(Array.from(FUNNEL_FILES).sort()).toEqual(
      [
        'src/core/AnthropicSubscriptionRouter.ts',
        'src/core/CircuitBreakingIntelligenceProvider.ts',
        'src/core/ClaudeCliIntelligenceProvider.ts',
        'src/core/CodexCliIntelligenceProvider.ts',
        'src/core/GeminiCliIntelligenceProvider.ts',
        'src/core/IntelligenceRouter.ts',
        'src/core/InteractivePoolIntelligenceProvider.ts',
        'src/core/PiCliIntelligenceProvider.ts',
        'src/core/TopicIntentCapture.ts',
      ].sort(),
    );
    // Every entry must exist on disk (a deleted funnel file must leave the list).
    for (const rel of FUNNEL_FILES) {
      expect(fs.existsSync(path.join(ROOT, rel)), `${rel} missing on disk`).toBe(true);
    }
  });

  it('the full-repo lint is clean (zero-baseline holds)', () => {
    const { real, stale } = runLint(walkSrc(), { checkStale: true });
    expect(real).toEqual([]);
    expect(stale).toEqual([]);
  });

  it('package.json wires lint:llm-attribution into the lint chain', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    expect(pkg.scripts['lint:llm-attribution']).toContain('lint-llm-attribution.js');
    expect(pkg.scripts['lint:llm-attribution:staged']).toContain('--staged');
    expect(pkg.scripts.lint).toContain('lint-llm-attribution.js');
  });
});

describe('lint self-test — the lexical heuristic', () => {
  const flag = (text: string) => checkFileText('src/fixture.ts', text);

  it('passes a tagged inline callsite', () => {
    expect(
      flag(`await this.intelligence.evaluate(prompt, { model: 'fast', attribution: { component: 'GateX' } });`),
    ).toEqual([]);
  });

  it('flags an untagged funnel callsite', () => {
    const v = flag(`await this.intelligence.evaluate(prompt, { model: 'fast' });`);
    expect(v).toHaveLength(1);
    expect(v[0].receiver).toContain('intelligence');
  });

  it('flags attribution: {} (empty)', () => {
    expect(flag(`await llm.evaluate(p, { attribution: {} });`)).toHaveLength(1);
  });

  it('flags component: "" and the reserved name "Unlabeled"', () => {
    expect(flag(`await llm.evaluate(p, { attribution: { component: '' } });`)).toHaveLength(1);
    expect(flag(`await llm.evaluate(p, { attribution: { component: 'Unlabeled' } });`)).toHaveLength(1);
  });

  it('passes a same-file const declaration carrying the literal', () => {
    const text = `
const sharedOpts = { model: 'fast', attribution: { component: 'DeclaredGate' } };
await this.provider.evaluate(p, sharedOpts);`;
    expect(flag(text)).toEqual([]);
  });

  it('passes the conditional shape (documented lexical limitation)', () => {
    expect(
      flag(`await intelligence.evaluate(p, { ...o, attribution: o.attribution ?? { component: 'Proxy' } });`),
    ).toEqual([]);
  });

  it('does not flag .evaluate( on non-funnel receivers', () => {
    expect(flag(`const x = await this.policyEvaluator.evaluate(input);`)).toEqual([]);
  });

  it('does not flag mentions inside comments (JSDoc wiring examples)', () => {
    const text = `
/**
 * summarize → queue.enqueue('background', () => intelligence.evaluate(prompt, { model: 'fast' }))
 */
export const x = 1; // intelligence.evaluate(p) in a line comment too`;
    expect(flag(text)).toEqual([]);
  });

  it('stripComments preserves line numbers and string contents', () => {
    const text = `const a = 'has // no comment';\n// real comment\nconst b = 2;`;
    const stripped = stripComments(text);
    expect(stripped.split('\n')).toHaveLength(3);
    expect(stripped).toContain(`'has // no comment'`);
    expect(stripped).not.toContain('real comment');
  });

  it('scope-outs: parity scenarios and smoke/stress files are out of scope by construction', () => {
    expect(isOutOfScope('src/providers/parity/scenarios/anything.ts')).toBe(true);
    expect(isOutOfScope('src/providers/adapters/anthropic-headless/_smoketest.ts')).toBe(true);
    expect(isOutOfScope('src/providers/adapters/openai-codex/_stresstest.ts')).toBe(true);
    expect(isOutOfScope('src/core/CodexCliIntelligenceProvider.ts')).toBe(false);
  });

  it('stale-entry rule: a dead allowlist entry is reported for removal', () => {
    const { stale } = runLint(walkSrc(), {
      allowlist: new Set(['src/never/Existed.ts:1']),
      checkStale: true,
    });
    expect(stale).toEqual(['src/never/Existed.ts:1']);
  });

  it('FUNNEL_FILES exemption: a forwarder file is skipped by path', () => {
    const funnelAbs = path.join(ROOT, 'src/core/CircuitBreakingIntelligenceProvider.ts');
    const { real } = runLint([funnelAbs]);
    expect(real).toEqual([]);
  });
});

describe('componentCategories wiring', () => {
  /**
   * Attribution labels intentionally NOT registered in COMPONENT_CATEGORY because
   * they pass an EXPLICIT `attribution.category` at their call site (so the router
   * resolves them by that category, not by this map). `categoryForComponent` — which
   * only consults the map — therefore returns 'other' for them, which is correct.
   * This list is PINNED: a NEW map-unregistered component name that does NOT pass an
   * explicit category fails this test; the fix is registering it in
   * src/core/componentCategories.ts, not extending this list.
   *
   * (The LLM Routing Registry audit, 2026-07-01, cleared the remaining pre-existing
   * backlog by registering InputClassifier, LLMConflictResolver, PreCompactionFlush,
   * ResumeValidator, SessionSummarySentinel, TelegramAdapter, TopicIntentExtractor,
   * TreeSynthesis, Usher, mentor-stage-b, openConversationBrief, a2a-checkin,
   * correction-learning — moving them off the default framework. See
   * docs/LLM-ROUTING-REGISTRY.md.)
   */
  const WIRING_EXCLUSIONS = new Set([
    'AmbientContributionGate',
    'BlockerSettleAuthority',
    'IntentLlmJudge',
    'LlmIntentClassifier',
    'RelationshipAnomalyScorer',
  ]);

  it('every literal attribution.component in src/ resolves to a registered category or a pinned exclusion', () => {
    const unresolved: string[] = [];
    const seen = new Set<string>();
    for (const file of walkSrc()) {
      const text = stripComments(fs.readFileSync(file, 'utf-8'));
      const re = /attribution[\s\S]{0,160}?component\s*:\s*(['"`])([^'"`]+)\1/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const name = m[2];
        if (seen.has(name)) continue;
        seen.add(name);
        const base = name.split('/')[0].replace(/^server:/, '').trim();
        if (categoryForComponent(name) === 'other' && !WIRING_EXCLUSIONS.has(base)) {
          unresolved.push(`${path.relative(ROOT, file)}: '${name}'`);
        }
      }
    }
    expect(
      unresolved,
      'Unregistered attribution.component label(s) — register in src/core/componentCategories.ts (Token-Audit Completeness standard)',
    ).toEqual([]);
    expect(seen.size).toBeGreaterThan(20); // the scan itself found real labels
  });

  it('the wiring exclusions are all still genuinely unregistered (stale exclusions must be removed)', () => {
    for (const name of WIRING_EXCLUSIONS) {
      expect(
        categoryForComponent(name),
        `'${name}' is now registered — remove it from WIRING_EXCLUSIONS`,
      ).toBe('other');
    }
  });

  it('the 8 baseline-zero components resolve to registered categories', () => {
    for (const name of [
      'WarrantsReplyGate',
      'PipeSessionSpawner',
      'LLMSanitizer',
      'OverrideDetector',
      'TaskClassifier',
      'InteractivePoolCanaryJudge',
      'SlackAdapter',
    ]) {
      expect(categoryForComponent(name), name).not.toBe('other');
    }
  });
});
