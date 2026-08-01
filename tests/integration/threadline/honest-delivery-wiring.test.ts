/**
 * Production-wiring regression for honest Threadline delivery receipts.
 *
 * A router refusal is now `handled:false`, but it can still carry a resolved
 * threadId. The relay-ingest fallback must only synthesize and retry when the
 * router could not resolve a thread at all; otherwise a real refused payload
 * would be handed to the router twice.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8');
}

describe('Threadline honest-delivery production wiring', () => {
  it('does not retry a threadless inbound message when the router already resolved its thread', () => {
    const server = read('src/commands/server.ts');

    expect(server).toContain('if (!result.handled && !result.threadId && !msg.threadId)');
  });

  it('passes the configured router through AgentServer into the real route context', () => {
    const agentServer = read('src/server/AgentServer.ts');
    const server = read('src/commands/server.ts');

    expect(agentServer).toContain('threadlineRouter: options.threadlineRouter ?? null');
    expect(server).toMatch(/new AgentServer\(\{[\s\S]*?\bthreadlineRouter,[\s\S]*?\}\);/);
  });

  it('marks both receiver accept boundaries as accepted but not delivered', () => {
    const routes = read('src/server/routes.ts');
    const endpoints = read('src/threadline/ThreadlineEndpoints.ts');
    const localStart = routes.indexOf("router.post('/messages/relay-agent'");
    const localEnd = routes.indexOf("router.get('/messages/inbox'", localStart);
    const localReceiver = routes.slice(localStart, localEnd);
    const signedStart = endpoints.indexOf("router.post('/threadline/messages/receive'");
    const signedEnd = endpoints.indexOf("router.post('/threadline/threads/backfill'", signedStart);
    const signedReceiver = endpoints.slice(signedStart, signedEnd);

    expect(localReceiver).toMatch(/if \(ctx\.threadlineRouter\)[\s\S]*accepted:\s*true,\s*\n\s*delivered:\s*false,\s*\n\s*threadline:/);
    expect(signedReceiver).toMatch(/accepted:\s*true,\s*\n\s*delivered:\s*false,\s*\n\s*async:/);
  });
});
