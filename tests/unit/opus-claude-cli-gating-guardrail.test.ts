/**
 * Opus×claude-CLI gating guardrail — INSTAR-Bench v3, Task-4 S2 (rules R1/R2).
 *
 * Two layers under test:
 *   1. `clampClaudeCliSwapModel` (src/core/IntelligenceRouter.ts) — the runtime
 *      clamp that narrows a bounded/gating failure-swap onto claude-code from the
 *      `capable` tier (=Opus, the banned 81.7%-via-CLI door) down to `balanced`
 *      (=Sonnet CLI reserve). Only ever narrows; never upgrades or blocks.
 *   2. The lint's pure predicates (scripts/lint-no-opus-claude-cli-gating.js) —
 *      guardrail-intactness (prong A) + the dangerous-config detector (prong B).
 *
 * Bench evidence: identical Opus 4.8 = 99.1% via clean API vs 81.7% via Claude
 * Code CLI (17.4-pt door penalty); emergency-stop 73% CLI. See docs/LLM-ROUTING-
 * REGISTRY.md R1/R2 and research/.../FULL-REPORT-ELI16.md §7.7/§9.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clampClaudeCliSwapModel } from '../../src/core/IntelligenceRouter.js';
import {
  checkGuardrailIntact,
  checkConfigObject,
} from '../../scripts/lint-no-opus-claude-cli-gating.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('clampClaudeCliSwapModel — the R1/R2 runtime clamp', () => {
  it('clamps capable→balanced when swapping onto claude-code (the banned Opus×CLI door)', () => {
    expect(clampClaudeCliSwapModel('claude-code', 'capable')).toEqual({
      model: 'balanced',
      clamped: true,
    });
  });

  it('leaves balanced/haiku untouched on claude-code (only capable=Opus is banned)', () => {
    expect(clampClaudeCliSwapModel('claude-code', 'balanced')).toEqual({
      model: 'balanced',
      clamped: false,
    });
    expect(clampClaudeCliSwapModel('claude-code', 'fast')).toEqual({
      model: 'fast',
      clamped: false,
    });
  });

  it('never touches capable on a non-claude-code door (Opus-via-API is fine)', () => {
    for (const fw of ['codex-cli', 'pi-cli', 'gemini-cli'] as const) {
      expect(clampClaudeCliSwapModel(fw, 'capable')).toEqual({ model: 'capable', clamped: false });
    }
  });

  it('passes an undefined tier through unchanged (no forced clamp)', () => {
    expect(clampClaudeCliSwapModel('claude-code', undefined)).toEqual({
      model: undefined,
      clamped: false,
    });
  });

  it('only ever NARROWS — it never upgrades a tier toward capable', () => {
    // Property: the output model is never `capable` when the input was not `capable`.
    for (const fw of ['claude-code', 'codex-cli', 'pi-cli'] as const) {
      for (const m of ['fast', 'balanced', undefined] as const) {
        expect(clampClaudeCliSwapModel(fw, m).model).not.toBe('capable');
      }
    }
  });
});

describe('lint prong A — guardrail intactness', () => {
  it('passes when the helper is defined AND invoked (≥2 mentions)', () => {
    const src = `
      export function clampClaudeCliSwapModel(t, r) { return { model: r, clamped: false }; }
      // ... swap loop ...
      const { model } = clampClaudeCliSwapModel(target, options?.model);
    `;
    expect(checkGuardrailIntact(src)).toEqual([]);
  });

  it('fails when the helper is missing entirely', () => {
    expect(checkGuardrailIntact('export class IntelligenceRouter {}').length).toBeGreaterThan(0);
  });

  it('fails when the helper is defined but never invoked (inert guard)', () => {
    const src = 'export function clampClaudeCliSwapModel(t, r) { return { model: r, clamped: false }; }';
    const problems = checkGuardrailIntact(src);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toMatch(/never invoked|inert/i);
  });

  it('the REAL router source passes prong A (regression: the guard is wired)', () => {
    // Read the actual file to prove the guardrail is live in-tree, not just in a fixture.
    const routerPath = path.resolve(__dirname, '../../src/core/IntelligenceRouter.ts');
    const routerSrc = fs.readFileSync(routerPath, 'utf8');
    expect(checkGuardrailIntact(routerSrc)).toEqual([]);
  });
});

describe('lint prong B — dangerous-config detector', () => {
  it('flags Opus claude-code default + claude-code in failureSwap (the banned combo)', () => {
    const cfg = {
      sessions: {
        componentFrameworks: { categories: { sentinel: 'pi-cli' }, failureSwap: ['pi-cli', 'claude-code'] },
        frameworkDefaultModels: { 'claude-code': 'claude-opus-4-8' },
      },
    };
    expect(checkConfigObject(cfg)).toMatch(/banned Opus/i);
  });

  it('flags Opus default + claude-code as a gate category', () => {
    const cfg = {
      componentFrameworks: { categories: { gate: 'claude-code' } },
      frameworkDefaultModels: { 'claude-code': 'capable' },
    };
    expect(checkConfigObject(cfg)).toMatch(/banned Opus/i);
  });

  it('is SAFE when claude-code default is Opus but claude-code is NOT a gating route (CHAIN WRITE lane)', () => {
    const cfg = {
      sessions: {
        componentFrameworks: { categories: { sentinel: 'pi-cli' }, failureSwap: ['pi-cli', 'codex-cli'] },
        frameworkDefaultModels: { 'claude-code': 'claude-opus-4-8' },
      },
    };
    expect(checkConfigObject(cfg)).toBeNull();
  });

  it('is SAFE when claude-code is a gating route but its default is NOT Opus (sonnet fallback)', () => {
    const cfg = {
      sessions: {
        componentFrameworks: { failureSwap: ['pi-cli', 'claude-code'] },
        frameworkDefaultModels: { 'claude-code': 'sonnet' },
      },
    };
    expect(checkConfigObject(cfg)).toBeNull();
  });

  it('is a no-op on a config with no routing block at all', () => {
    expect(checkConfigObject({ foo: 'bar' })).toBeNull();
    expect(checkConfigObject(null)).toBeNull();
  });
});
