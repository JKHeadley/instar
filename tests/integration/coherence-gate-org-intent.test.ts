/**
 * Integration tests — Coherence Gate × ORG-INTENT.md HTTP integration.
 *
 * Tier 2 of the Testing Integrity Standard: full HTTP pipeline from
 * `POST /review/evaluate` through CoherenceGate → reviewer prompts. Asserts
 * that ORG-INTENT.md on disk is loaded by OrgIntentManager, surfaced as
 * structured constraints/goals/values/tradeoffHierarchy in the value-alignment
 * reviewer prompt, and that the gate's pass/block decision reflects the
 * reviewer's verdict on a constraint violation.
 *
 * Uses a real CoherenceGate with a stubbed IntelligenceProvider so the test
 * exercises real routing + parsing but is deterministic about LLM verdicts.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import type { Server } from 'node:http';
import { CoherenceGate } from '../../src/core/CoherenceGate.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig, IntelligenceProvider, IntelligenceOptions, ResponseReviewConfig } from '../../src/core/types.js';

interface CapturedPrompt {
  prompt: string;
  model: string;
}

function makeStubIntelligence(capture: CapturedPrompt[]): IntelligenceProvider {
  // Scripted responses keyed by which reviewer's preamble is detected. The
  // gate reviewer fires first and decides whether to fan out to specialists.
  // For ORG-INTENT-aware tests, we always force a full fan-out (needsReview:true)
  // and configure value-alignment to block on constraint violations.
  const evaluate = vi.fn(async (prompt: string, options?: IntelligenceOptions): Promise<string> => {
    capture.push({ prompt, model: options?.model ?? 'unknown' });

    if (prompt.includes('"needsReview"') || prompt.includes('triage')) {
      return JSON.stringify({ needsReview: true, reason: 'Forced fan-out for org-intent test' });
    }

    if (prompt.includes('value alignment reviewer')) {
      // Detect constraint-violation marker injected by the caller test
      if (prompt.includes('VIOLATES_ORG_CONSTRAINT_MARKER')) {
        return JSON.stringify({
          pass: false,
          severity: 'block',
          issue: 'Response violates org constraint: never quote internal pricing externally',
          suggestion: 'Remove the pricing disclosure or escalate to a human.',
        });
      }
      return JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' });
    }

    // Every other reviewer passes
    return JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' });
  });

  return { evaluate } as unknown as IntelligenceProvider;
}

let projectDir: string;
let stateDir: string;
let server: Server;
let baseUrl: string;
let gate: CoherenceGate;
let capturedPrompts: CapturedPrompt[];

const AUTH_TOKEN = 'org-intent-integration';

function writeOrgIntent(content: string) {
  fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), content);
  // Bust the value-doc cache by reaching into the gate (test-only)
  (gate as unknown as { valueDocCache: unknown }).valueDocCache = null;
}

describe('Coherence Gate × ORG-INTENT.md HTTP integration', () => {
  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-coh-orgintent-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ projectName: 'coh-orgintent-test', autonomyProfile: 'collaborative' }),
    );

    // Minimal AGENT.md so value-alignment has agent-side context too
    fs.writeFileSync(
      path.join(stateDir, 'AGENT.md'),
      '# TestAgent\n## Intent\n- Be helpful\n- Respect organizational constraints\n',
    );

    capturedPrompts = [];
    const intelligence = makeStubIntelligence(capturedPrompts);

    const reviewConfig: ResponseReviewConfig = {
      enabled: true,
      reviewers: {
        // Disable noisy reviewers; keep only the ones relevant to this test.
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

    gate = new CoherenceGate({
      config: reviewConfig,
      stateDir,
      intelligence,
    });

    const config: InstarConfig = {
      projectDir,
      stateDir,
      projectName: 'coh-orgintent-test',
      authToken: AUTH_TOKEN,
      responseReview: reviewConfig,
    } as InstarConfig;

    const state = new StateManager(stateDir);

    const app = express();
    app.use(express.json());

    // Bearer-token auth middleware (mirrors AgentServer behavior)
    app.use((req, res, next) => {
      const auth = req.headers.authorization;
      if (!auth || auth !== `Bearer ${AUTH_TOKEN}`) {
        // Allow /health unauthenticated, but this test never calls it
        if (req.path === '/health') return next();
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    });

    const router = createRoutes({
      config,
      state,
      sessionManager: null as any,
      scheduler: null,
      telegram: null,
      relationships: null,
      feedback: null,
      dispatches: null,
      updateChecker: null,
      autoUpdater: null,
      autoDispatcher: null,
      quotaTracker: null,
      publisher: null,
      viewer: null,
      tunnel: null,
      evolution: null,
      watchdog: null,
      triageNurse: null,
      topicMemory: null,
      feedbackAnomalyDetector: null,
      projectMapper: null,
      coherenceGate: null,
      contextHierarchy: null,
      canonicalState: null,
      operationGate: null,
      sentinel: null,
      adaptiveTrust: null,
      memoryMonitor: null,
      orphanReaper: null,
      coherenceMonitor: null,
      commitmentTracker: null,
      semanticMemory: null,
      activitySentinel: null,
      messageRouter: null,
      summarySentinel: null,
      spawnManager: null,
      workingMemory: null,
      quotaManager: null,
      systemReviewer: null,
      capabilityMapper: null,
      selfKnowledgeTree: null,
      coverageAuditor: null,
      topicResumeMap: null,
      autonomyManager: null,
      trustElevationTracker: null,
      autonomousEvolution: null,
      whatsapp: null,
      messageBridge: null,
      hookEventReceiver: null,
      worktreeMonitor: null,
      subagentTracker: null,
      instructionsVerifier: null,
      threadlineRouter: null,
      handshakeManager: null,
      threadlineRelayClient: null,
      listenerManager: null,
      responseReviewGate: gate,
      telemetryHeartbeat: null,
      pasteManager: null,
      wsManager: null,
      soulManager: null,
      discoveryEvaluator: null,
      startTime: new Date(),
    } as any);

    app.use(router);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/integration/coherence-gate-org-intent.test.ts:afterAll',
    });
  });

  it('POST /review/evaluate without ORG-INTENT.md → pass-through, no structured intent in prompt', async () => {
    // Make sure ORG-INTENT.md is absent for this case
    const orgIntentPath = path.join(stateDir, 'ORG-INTENT.md');
    if (fs.existsSync(orgIntentPath)) {
      SafeFsExecutor.safeRmSync(orgIntentPath, {
        force: true,
        operation: 'tests/integration/coherence-gate-org-intent.test.ts:absent-case-setup',
      });
    }
    (gate as unknown as { valueDocCache: unknown }).valueDocCache = null;
    capturedPrompts.length = 0;

    const res = await fetch(`${baseUrl}/review/evaluate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({
        message: 'Got it, working on that.',
        sessionId: 'no-org-intent',
        stopHookActive: false,
        context: { channel: 'direct' },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pass).toBe(true);

    const valueAlignmentPrompt = capturedPrompts.find(p => p.prompt.includes('value alignment reviewer'));
    if (valueAlignmentPrompt) {
      // When orgIntent is null, the prompt block falls back to the sentinel
      expect(valueAlignmentPrompt.prompt).toContain('No organizational intent provided.');
      expect(valueAlignmentPrompt.prompt).not.toContain('CONSTRAINTS (mandatory — violations MUST block)');
    }
  });

  it('POST /review/evaluate with ORG-INTENT.md → structured intent surfaced in prompt, conformant message passes', async () => {
    writeOrgIntent(`# Organizational Intent: Acme Co

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
`);
    capturedPrompts.length = 0;

    const res = await fetch(`${baseUrl}/review/evaluate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({
        message: 'Hi! I am an AI assistant. How can I help you today?',
        sessionId: 'conformant-1',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true, recipientType: 'primary-user' },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pass).toBe(true);

    const valueAlignmentPrompt = capturedPrompts.find(p => p.prompt.includes('value alignment reviewer'));
    expect(valueAlignmentPrompt).toBeDefined();
    expect(valueAlignmentPrompt!.prompt).toContain('CONSTRAINTS (mandatory — violations MUST block)');
    expect(valueAlignmentPrompt!.prompt).toContain('GOALS (organizational defaults');
    expect(valueAlignmentPrompt!.prompt).toContain('VALUES (representation — drift warns)');
    expect(valueAlignmentPrompt!.prompt).toContain('TRADEOFF HIERARCHY (earlier wins');
    expect(valueAlignmentPrompt!.prompt).toContain('Never quote internal pricing to external contacts');
    expect(valueAlignmentPrompt!.prompt).toContain('Customer trust over resolution speed');
  });

  it('POST /review/evaluate with ORG-INTENT.md and constraint-violating reviewer verdict → block', async () => {
    writeOrgIntent(`# Organizational Intent: Acme Co

## Constraints (Mandatory)
- Never quote internal pricing to external contacts
`);
    capturedPrompts.length = 0;

    const res = await fetch(`${baseUrl}/review/evaluate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({
        // VIOLATES_ORG_CONSTRAINT_MARKER is detected by our stub intelligence
        // to force value-alignment to return severity=block. In real usage the
        // LLM makes this call based on the actual content; the marker is just
        // a deterministic test seam.
        message: 'Our internal pricing tier for premium customers is $9/seat — that is below cost. VIOLATES_ORG_CONSTRAINT_MARKER',
        sessionId: 'constraint-violation-1',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true, recipientType: 'primary-user' },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pass).toBe(false);
    expect(body.feedback).toBeDefined();
    expect(body.issueCategories).toContain('ALIGNMENT ISSUE');
  });

  it('POST /review/evaluate with template-only ORG-INTENT.md → behaves like absent (no structured surfacing)', async () => {
    writeOrgIntent(`# Organizational Intent: <!-- name -->

<!-- nothing real here yet -->

## Constraints (Mandatory)
<!-- list constraints -->
`);
    capturedPrompts.length = 0;

    const res = await fetch(`${baseUrl}/review/evaluate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({
        message: 'Got it.',
        sessionId: 'template-only-1',
        stopHookActive: false,
        context: { channel: 'direct' },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pass).toBe(true);

    const valueAlignmentPrompt = capturedPrompts.find(p => p.prompt.includes('value alignment reviewer'));
    if (valueAlignmentPrompt) {
      // Template-only file parses to null; structured surfacing skipped
      expect(valueAlignmentPrompt.prompt).not.toContain('CONSTRAINTS (mandatory — violations MUST block)');
    }
  });
});
