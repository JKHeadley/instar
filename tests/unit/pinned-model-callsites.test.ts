/**
 * Pinned-callsite model migration (LLM-ROUTING-REGISTRY.md risk items
 * #3/#5/#6/#7) — config/env-overridable models with behavior-preserving
 * inline defaults.
 *
 * Semantic-correctness coverage: BOTH sides of every decision boundary —
 * (a) override ABSENT ⇒ the shipped default applies byte-for-byte,
 * (b) override PRESENT ⇒ the operator's value wins.
 *
 * Wiring coverage: canary-style source assertions that server.ts actually
 * threads `intelligence.pinnedModels.*` into the construction sites (the
 * pattern proven by setup-codex-model-canary.test.ts).
 *
 * NOTE (risk item #4, mentor loop): deliberately NOT migrated here — it was
 * already config-driven via `mentor.autonomousFix.model` (default 'opus');
 * see MentorOnboardingRunner.autonomousTick (`af.model || 'opus'`). A canary
 * below pins that fact so the registry row stays honest.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WIZARD_CODEX_MODEL,
  WIZARD_CODEX_MODEL_DEFAULT,
  GEMINI_WIZARD_MODEL,
  GEMINI_WIZARD_MODEL_DEFAULT,
  resolveWizardCodexModel,
  resolveWizardGeminiModel,
} from '../../src/commands/setup-wizard/model-constants.js';
import { DispatchExecutor } from '../../src/core/DispatchExecutor.js';
import type { SessionManager } from '../../src/core/SessionManager.js';
import { createAuthCredentialInjection } from '../../src/providers/adapters/anthropic-headless/control/authCredentialInjection.js';
import type { AnthropicHeadlessConfig } from '../../src/providers/adapters/anthropic-headless/config.js';
import { ANTHROPIC_MODELS } from '../../src/core/models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_SRC = path.resolve(__dirname, '../../src/commands/server.ts');
const MENTOR_RUNNER_SRC = path.resolve(
  __dirname,
  '../../src/scheduler/MentorOnboardingRunner.ts',
);

// ── Wizard model resolvers (risk items #5/#6 — env-overridable) ──────

describe('setup-wizard model resolvers', () => {
  it('codex: default applies when the env override is absent', () => {
    expect(resolveWizardCodexModel({})).toBe(WIZARD_CODEX_MODEL_DEFAULT);
    expect(WIZARD_CODEX_MODEL_DEFAULT).toBe('gpt-5.3-codex');
  });

  it('codex: env override wins when set', () => {
    expect(
      resolveWizardCodexModel({ INSTAR_WIZARD_CODEX_MODEL: 'gpt-5.4' }),
    ).toBe('gpt-5.4');
  });

  it('codex: whitespace-only override is ignored (default applies)', () => {
    expect(
      resolveWizardCodexModel({ INSTAR_WIZARD_CODEX_MODEL: '   ' }),
    ).toBe(WIZARD_CODEX_MODEL_DEFAULT);
  });

  it('gemini: default applies when the env override is absent', () => {
    expect(resolveWizardGeminiModel({})).toBe(GEMINI_WIZARD_MODEL_DEFAULT);
    expect(GEMINI_WIZARD_MODEL_DEFAULT).toBe('gemini-2.5-flash');
  });

  it('gemini: env override wins when set', () => {
    expect(
      resolveWizardGeminiModel({ INSTAR_WIZARD_GEMINI_MODEL: 'gemini-3-flash' }),
    ).toBe('gemini-3-flash');
  });

  it('module-level consts stay resolver-derived (no test env override set)', () => {
    // In the test environment the override vars are unset, so the exported
    // consts must equal the shipped defaults — the behavior-preservation
    // guarantee for every existing import site.
    expect(WIZARD_CODEX_MODEL).toBe(WIZARD_CODEX_MODEL_DEFAULT);
    expect(GEMINI_WIZARD_MODEL).toBe(GEMINI_WIZARD_MODEL_DEFAULT);
  });
});

// ── DispatchExecutor agentic model (risk item #3) ─────────────────────

describe('DispatchExecutor agentic-session model', () => {
  function makeCapturingSessionManager(): {
    sm: SessionManager;
    captured: Array<Record<string, unknown>>;
  } {
    const captured: Array<Record<string, unknown>> = [];
    const sm = {
      spawnSession: async (opts: Record<string, unknown>) => {
        captured.push(opts);
        return 'tmux-test-session';
      },
    } as unknown as SessionManager;
    return { sm, captured };
  }

  const agenticPayload = {
    description: 'test agentic dispatch',
    steps: [{ type: 'agentic' as const, prompt: 'do the thing' }],
  };

  it("defaults to 'haiku' when no override is configured (behavior-preserving)", async () => {
    const { sm, captured } = makeCapturingSessionManager();
    const exec = new DispatchExecutor('/tmp/does-not-matter', sm);
    const result = await exec.execute(agenticPayload);
    expect(result.success).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].model).toBe('haiku');
  });

  it('uses the configured agenticModel override when provided', async () => {
    const { sm, captured } = makeCapturingSessionManager();
    const exec = new DispatchExecutor('/tmp/does-not-matter', sm, {
      agenticModel: 'sonnet',
    });
    const result = await exec.execute(agenticPayload);
    expect(result.success).toBe(true);
    expect(captured[0].model).toBe('sonnet');
  });

  it('treats a whitespace-only override as absent (default applies)', async () => {
    const { sm, captured } = makeCapturingSessionManager();
    const exec = new DispatchExecutor('/tmp/does-not-matter', sm, {
      agenticModel: '  ',
    });
    await exec.execute(agenticPayload);
    expect(captured[0].model).toBe('haiku');
  });
});

// ── anthropic-headless credential-probe model (risk item #7) ──────────

describe('anthropic-headless credential-probe model', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function captureProbeBody(): { bodies: Array<Record<string, unknown>> } {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? '{}'));
      return { ok: true, text: async () => '' } as Response;
    }) as typeof fetch;
    return { bodies };
  }

  const baseConfig: AnthropicHeadlessConfig = {
    claudePath: '/usr/local/bin/claude',
    tmuxPath: '/usr/local/bin/tmux',
  };
  const apiKeyCredential = { kind: 'api-key' as const, key: 'sk-ant-api-test' };

  it('defaults to the models.ts haiku tier (not a string literal drifting alone)', async () => {
    const { bodies } = captureProbeBody();
    const injection = createAuthCredentialInjection(baseConfig);
    await injection.probe(apiKeyCredential);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].model).toBe(ANTHROPIC_MODELS.haiku);
  });

  it('uses credentialProbeModel override when configured', async () => {
    const { bodies } = captureProbeBody();
    const injection = createAuthCredentialInjection({
      ...baseConfig,
      credentialProbeModel: 'claude-sonnet-4-6',
    });
    await injection.probe(apiKeyCredential);
    expect(bodies[0].model).toBe('claude-sonnet-4-6');
  });

  it('treats a whitespace-only override as absent (default applies)', async () => {
    const { bodies } = captureProbeBody();
    const injection = createAuthCredentialInjection({
      ...baseConfig,
      credentialProbeModel: '  ',
    });
    await injection.probe(apiKeyCredential);
    expect(bodies[0].model).toBe(ANTHROPIC_MODELS.haiku);
  });
});

// ── Wiring canaries (server.ts threads config → construction sites) ───

describe('server.ts pinnedModels wiring canary', () => {
  const serverSrc = fs.readFileSync(SERVER_SRC, 'utf-8');

  it('threads pinnedModels.dispatchAgentic into the DispatchExecutor construction', () => {
    expect(serverSrc).toMatch(
      /new DispatchExecutor\([\s\S]{0,400}pinnedModels\?\.dispatchAgentic/,
    );
  });

  it('threads pinnedModels.anthropicCredentialProbe into registerAnthropicAdapters', () => {
    expect(serverSrc).toMatch(
      /registerAnthropicAdapters\(\{[\s\S]{0,900}pinnedModels\?\.anthropicCredentialProbe/,
    );
    expect(serverSrc).toMatch(/credentialProbeModel:/);
  });
});

// ── Mentor-loop canary (risk item #4 — already config-driven) ─────────

describe('mentor autonomous-fix model stays config-driven', () => {
  it("MentorOnboardingRunner reads af.model with the 'opus' fallback", () => {
    const src = fs.readFileSync(MENTOR_RUNNER_SRC, 'utf-8');
    expect(src).toMatch(/af\.model\s*\|\|\s*'opus'/);
  });
});
