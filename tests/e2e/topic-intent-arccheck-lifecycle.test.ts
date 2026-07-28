/**
 * E2E lifecycle (Tier 3) for the topic-intent ARCCHECK wiring (Layer 3).
 *
 * Regression pin against the founding-drift incident (topic 13481, 2026-05-27):
 *   - The agent drafted "we eventually need a second machine for the
 *     cross-machine seamlessness test."
 *   - The topic's SETTLED briefing already contained "the mac-mini is already
 *     configured." ArcCheck SHOULD have fired `contradicts-settled` and sent a
 *     signal to MessagingToneGate. It didn't, because the classifier was
 *     never wired (AgentServer constructed createTopicIntentRoutes with no
 *     `arcCheck` instance, and no production caller invoked the route).
 *
 * This test reconstructs the production composition (createArcCheckClassifyFn
 * built from a stub IntelligenceProvider; ArcCheck instance shared by the
 * HTTP route), seeds the mac-mini SETTLED ref, posts the drift draft, and
 * proves end-to-end that:
 *   - the ArcCheck endpoint is alive (200, not 503),
 *   - the classifier identifies the contradicts-settled engagement,
 *   - capture-metrics arccheck_fired AND arccheck_signalled both increment,
 *   - the server.ts source contains the live wiring (anti-shipped-but-asleep
 *     source guard, mirroring the capture-loop test).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import express from 'express';
import type { Server } from 'node:http';
import request from 'supertest';
import { TopicIntentStore, buildEvent } from '../../src/core/TopicIntent.js';
import {
  ArcCheck,
  createArcCheckClassifyFn,
} from '../../src/core/TopicIntentArcCheck.js';
import { createTopicIntentRoutes } from '../../src/server/topicIntentRoutes.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const TOPIC = 9200;
const SETTLED_REF = 'ref-mac-mini-configured';
const SETTLED_TEXT =
  'The multi-machine Luna infrastructure is ready to proceed — the mac-mini is already configured and SSH-reachable.';

describe('E2E: topic-intent ArcCheck lifecycle (mac-mini drift regression pin)', () => {
  let stateDir: string;
  let server: Server;
  let store: TopicIntentStore;
  let providerCalls = 0;

  beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-intent-arccheck-e2e-'));
    store = new TopicIntentStore(stateDir);

    // Seed the mac-mini ref at AUTHORITATIVE tier (extract-user + user-affirm)
    // — exactly how the briefing's SETTLED block is built in real conversations.
    store.appendEvidence(TOPIC, SETTLED_REF, buildEvent(SETTLED_REF, 'extract-user', 'seed-1'), {
      text: SETTLED_TEXT,
      kind: 'fact',
    });
    store.appendEvidence(TOPIC, SETTLED_REF, buildEvent(SETTLED_REF, 'user-affirm', 'seed-2'));

    // Sanity: the seeded ref is now at authoritative tier.
    const refs = store.getRefsAtOrAbove(TOPIC, 'tentative');
    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(refs[0].projection.tier).toBe('authoritative');

    // Stub IntelligenceProvider mirroring the production subscription path.
    // Returns the contradicts classification when it sees the drift draft.
    const provider: IntelligenceProvider = {
      async evaluate(prompt: string) {
        providerCalls++;
        // The drift draft mentions needing a machine — the classifier marks
        // the mac-mini ref as contradicted.
        if (/second machine|need.*machine/i.test(prompt)) {
          return `{"actsOn":[],"contradicts":["${SETTLED_REF}"]}`;
        }
        return '{"actsOn":[],"contradicts":[]}';
      },
    };

    const classify = createArcCheckClassifyFn(provider);
    const arcCheck = new ArcCheck(store, classify);

    // HTTP surface — exactly how AgentServer mounts it, with the ArcCheck
    // instance plugged in via createTopicIntentRoutes.
    const app = express();
    app.use(express.json());
    app.use(createTopicIntentRoutes({ topicIntentStore: store, arcCheck }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      SafeFsExecutor.safeRmSync(stateDir, {
        recursive: true,
        force: true,
        operation: 'tests/e2e/topic-intent-arccheck-lifecycle.test.ts',
      });
    } catch {
      /* best-effort */
    }
  });

  it('the feature is alive: arccheck endpoint returns 200, not 503', async () => {
    const res = await request(server)
      .post(`/topic-intent/${TOPIC}/arccheck`)
      .send({ draftText: 'placeholder draft', forUserTurn: 1 });
    expect(res.status).toBe(200);
    // Either fire or no-fire — both are 200; this just proves the route ran
    // and the classifier was reachable (not the degrade-open stub).
    expect(res.body).toHaveProperty('fire');
  });

  it('REGRESSION PIN — drift draft fires contradicts-settled against the mac-mini ref', async () => {
    const draftText =
      'We eventually need a second machine for the cross-machine seamlessness test.';

    const res = await request(server)
      .post(`/topic-intent/${TOPIC}/arccheck`)
      .send({ draftText, forUserTurn: 42 });

    expect(res.status).toBe(200);
    expect(res.body.fire).toBe(true);
    expect(res.body.kind).toBe('contradicts-settled');
    expect(res.body.refId).toBe(SETTLED_REF);
    expect(res.body.refText).toBe(SETTLED_TEXT);
    expect(res.body.suggestedRewriteHint).toMatch(/contradiction|settled/i);
  });

  it('the funnel meter both arccheck_fired and arccheck_signalled increments on a fire', async () => {
    const before = await request(server).get(`/topic-intent/${TOPIC}/capture-metrics`);
    const firedBefore = before.body.funnel.arccheck_fired ?? 0;
    const signalledBefore = before.body.funnel.arccheck_signalled ?? 0;

    await request(server)
      .post(`/topic-intent/${TOPIC}/arccheck`)
      .send({ draftText: 'We need a second machine — adding one to the test.' });

    const after = await request(server).get(`/topic-intent/${TOPIC}/capture-metrics`);
    expect(after.body.funnel.arccheck_fired).toBeGreaterThanOrEqual(firedBefore + 1);
    expect(after.body.funnel.arccheck_signalled).toBeGreaterThanOrEqual(signalledBefore + 1);
  });

  it('TRANSPORT — classifier delegated to the injected provider (never raw API)', () => {
    expect(providerCalls).toBeGreaterThanOrEqual(1);
  });

  it('WIRING-INTEGRITY (source guard) — server.ts actually constructs ArcCheck and passes it through', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const serverSrc = fs.readFileSync(
      path.join(here, '../../src/commands/server.ts'),
      'utf-8',
    );
    expect(serverSrc).toContain('createArcCheckClassifyFn');
    expect(serverSrc).toContain('__instarTopicIntentArcCheckWired');
    expect(serverSrc).toMatch(/topicIntentArcCheck\s*=\s*new ArcCheck\(/);

    // AgentServer must forward the instance to the routes.
    const agentServerSrc = fs.readFileSync(
      path.join(here, '../../src/server/AgentServer.ts'),
      'utf-8',
    );
    expect(agentServerSrc).toMatch(/arcCheck:\s*options\.topicIntentArcCheck/);

    // The route must accept an ArcCheck instance directly (not a classifier).
    const routesSrc = fs.readFileSync(
      path.join(here, '../../src/server/topicIntentRoutes.ts'),
      'utf-8',
    );
    expect(routesSrc).toMatch(/arcCheck\?:\s*ArcCheck \| null/);

    // checkOutboundMessage must call the in-process ArcCheck.
    const outboundSrc = fs.readFileSync(path.join(here, '../../src/server/routes.ts'), 'utf-8');
    expect(outboundSrc).toContain('ctx.topicIntentArcCheck');
    expect(outboundSrc).toContain('signals.arcCheck');
  });
});
