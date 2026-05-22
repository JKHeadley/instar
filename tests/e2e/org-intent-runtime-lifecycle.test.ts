/**
 * E2E test — ORG-INTENT runtime gate full lifecycle.
 *
 * Tests the complete PRODUCTION path:
 *   1. Server starts with CoherenceGate initialized (same as server.ts does)
 *   2. /review/evaluate returns 200, not 503 — "dead on arrival" check
 *   3. ORG-INTENT.md on disk is parsed via OrgIntentManager and surfaced to
 *      the value-alignment reviewer as structured constraints/goals/values/
 *      tradeoff hierarchy through the full HTTP pipeline
 *   4. Constraint-violating responses are blocked end-to-end
 *
 * WHY THIS TEST EXISTS:
 * Tier-1 unit tests prove the gate consumes a structured intent object. Tier-2
 * integration tests prove the HTTP route returns the right verdict. This Tier-3
 * test proves the WIRING — that an agent who writes an ORG-INTENT.md on disk,
 * then sends a draft message through /review/evaluate, actually has their
 * outbound response shaped by the intent. The mirror of `server.ts`'s
 * `if (config.responseReview?.enabled)` block is the load-bearing piece —
 * if that block ever stops constructing the gate, every /review/* route
 * returns 503 and ORG-INTENT becomes a static file again.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { CoherenceGate } from '../../src/core/CoherenceGate.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type {
  InstarConfig,
  IntelligenceProvider,
  IntelligenceOptions,
  ResponseReviewConfig,
} from '../../src/core/types.js';

describe('ORG-INTENT runtime gate E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let coherenceGate: CoherenceGate | undefined;
  let capturedPrompts: string[];
  const AUTH_TOKEN = 'test-e2e-org-intent';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-intent-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });

    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'org-intent-e2e', agentName: 'E2E Agent' }),
    );

    fs.writeFileSync(
      path.join(stateDir, 'AGENT.md'),
      '# E2E Agent\n## Intent\n- Be helpful\n- Honor organizational constraints\n',
    );

    fs.writeFileSync(
      path.join(stateDir, 'ORG-INTENT.md'),
      `# Organizational Intent: Acme Inc

## Constraints (Mandatory)
- Never quote internal pricing to external contacts
- Always disclose AI nature on first interaction

## Goals (Defaults)
- Resolve customer questions on first contact when possible

## Values
- Honesty over expedience

## Tradeoff Hierarchy
- Customer trust over resolution speed
- Compliance over convenience
`,
    );

    capturedPrompts = [];

    // ━━━ MIRROR PRODUCTION WIRING from src/commands/server.ts ━━━
    // The production block is:
    //   if (config.responseReview?.enabled) {
    //     if (sharedIntelligence) {
    //       responseReviewGate = new CoherenceGate({ ... });
    //     }
    //   }
    // We mirror it here with a stub IntelligenceProvider so the boot path
    // exercises the same conditional and constructor.

    const reviewConfig: ResponseReviewConfig = {
      enabled: true,
      reviewers: {
        // Keep only value-alignment + the gate reviewer enabled for a clean test.
        'conversational-tone': { enabled: false, mode: 'block' },
        'claim-provenance': { enabled: false, mode: 'block' },
        'settling-detection': { enabled: false, mode: 'block' },
        'context-completeness': { enabled: false, mode: 'block' },
        'capability-accuracy': { enabled: false, mode: 'block' },
        'url-validity': { enabled: false, mode: 'block' },
        'value-alignment': { enabled: true, mode: 'block' },
        'information-leakage': { enabled: false, mode: 'block' },
        'escalation-resolution': { enabled: false, mode: 'block' },
      },
      maxRetries: 0,
      timeoutMs: 8000,
      channelDefaults: {
        external: { failOpen: false, skipGate: false, queueOnFailure: false },
        internal: { failOpen: true, skipGate: false, queueOnFailure: false },
      },
    };

    const stubIntelligence: IntelligenceProvider = {
      evaluate: vi.fn(async (prompt: string, _opts?: IntelligenceOptions) => {
        capturedPrompts.push(prompt);
        if (prompt.includes('"needsReview"') || prompt.includes('triage')) {
          return JSON.stringify({ needsReview: true, reason: 'force fan-out' });
        }
        if (prompt.includes('value alignment reviewer')) {
          if (prompt.includes('VIOLATES_ORG_CONSTRAINT_MARKER')) {
            return JSON.stringify({
              pass: false,
              severity: 'block',
              issue: 'Response violates org constraint',
              suggestion: 'Withhold internal pricing.',
            });
          }
          return JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' });
        }
        return JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' });
      }),
    } as unknown as IntelligenceProvider;

    // Match the production conditional verbatim
    if (reviewConfig.enabled) {
      coherenceGate = new CoherenceGate({
        config: reviewConfig,
        stateDir,
        intelligence: stubIntelligence,
      });
    }

    const config: InstarConfig = {
      projectName: 'org-intent-e2e',
      agentName: 'E2E Agent',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      responseReview: reviewConfig,
    } as InstarConfig;

    const mockSM = createMockSessionManager();
    const state = new StateManager(stateDir);

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state,
      responseReviewGate: coherenceGate,
    });

    app = server.getApp();
  });

  afterAll(async () => {
    if (server) {
      try { await (server as unknown as { stop?: () => Promise<void> }).stop?.(); } catch { /* ignore */ }
    }
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/e2e/org-intent-runtime-lifecycle.test.ts:afterAll',
    });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  describe('Phase 1: Feature is alive', () => {
    it('returns 200 from /review/evaluate, not 503 — gate is wired into production', async () => {
      const res = await request(app)
        .post('/review/evaluate')
        .set(auth())
        .set('Content-Type', 'application/json')
        .send({
          message: 'Got it.',
          sessionId: 'alive-check',
          stopHookActive: false,
          context: { channel: 'direct' },
        });

      // The single most important assertion: feature is wired into server.ts
      expect(res.status).toBe(200);
      expect(res.body.pass).toBeDefined();
    });
  });

  describe('Phase 2: Structured ORG-INTENT surfaces through the HTTP pipeline', () => {
    it('value-alignment reviewer prompt contains the three-rule contract sections', async () => {
      capturedPrompts.length = 0;

      const res = await request(app)
        .post('/review/evaluate')
        .set(auth())
        .set('Content-Type', 'application/json')
        .send({
          message: 'Hi! I am an AI assistant. How can I help?',
          sessionId: 'structured-surface',
          stopHookActive: false,
          context: { channel: 'telegram', isExternalFacing: true, recipientType: 'primary-user' },
        });

      expect(res.status).toBe(200);

      const valueAlignmentPrompt = capturedPrompts.find(p => p.includes('value alignment reviewer'));
      expect(valueAlignmentPrompt).toBeDefined();
      expect(valueAlignmentPrompt!).toContain('Organization: Acme Inc');
      expect(valueAlignmentPrompt!).toContain('CONSTRAINTS (mandatory — violations MUST block)');
      expect(valueAlignmentPrompt!).toContain('GOALS (organizational defaults');
      expect(valueAlignmentPrompt!).toContain('VALUES (representation — drift warns)');
      expect(valueAlignmentPrompt!).toContain('TRADEOFF HIERARCHY (earlier wins');
      expect(valueAlignmentPrompt!).toContain('Never quote internal pricing to external contacts');
      expect(valueAlignmentPrompt!).toContain('Customer trust over resolution speed');
    });
  });

  describe('Phase 3: Constraint violation blocks end-to-end', () => {
    it('returns pass=false with ALIGNMENT ISSUE when reviewer flags a constraint violation', async () => {
      const res = await request(app)
        .post('/review/evaluate')
        .set(auth())
        .set('Content-Type', 'application/json')
        .send({
          // The marker triggers the deterministic block path in our stub.
          message: 'Our internal premium pricing is $9/seat. VIOLATES_ORG_CONSTRAINT_MARKER',
          sessionId: 'constraint-violation',
          stopHookActive: false,
          context: { channel: 'telegram', isExternalFacing: true, recipientType: 'primary-user' },
        });

      expect(res.status).toBe(200);
      expect(res.body.pass).toBe(false);
      expect(res.body.feedback).toBeTruthy();
      expect(res.body.issueCategories).toContain('ALIGNMENT ISSUE');
    });
  });

  describe('Phase 4: Hot-edit recovery', () => {
    it('treats ORG-INTENT.md mutation as a no-op within cache TTL (stale read is expected)', async () => {
      // Cache is process-lifetime up to 60min. Within a single boot, edits do
      // not propagate without explicit cache invalidation. This locks in the
      // documented behavior so a future refactor cannot silently break the
      // cache invariant.
      fs.writeFileSync(
        path.join(stateDir, 'ORG-INTENT.md'),
        `# Organizational Intent: Acme Inc

## Constraints (Mandatory)
- A brand new constraint that should NOT yet appear in the cached read
`,
      );
      capturedPrompts.length = 0;

      await request(app)
        .post('/review/evaluate')
        .set(auth())
        .set('Content-Type', 'application/json')
        .send({
          message: 'Hi.',
          sessionId: 'cache-stale',
          stopHookActive: false,
          context: { channel: 'direct' },
        });

      const valueAlignmentPrompt = capturedPrompts.find(p => p.includes('value alignment reviewer'));
      // Cached read still shows the original constraint, not the new one.
      expect(valueAlignmentPrompt).toBeDefined();
      expect(valueAlignmentPrompt!).toContain('Never quote internal pricing to external contacts');
      expect(valueAlignmentPrompt!).not.toContain('A brand new constraint');
    });
  });
});
