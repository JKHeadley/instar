import fs from 'node:fs';
import { createRequire } from 'node:module';
import request, { type Test } from 'supertest';
import { expect } from 'vitest';

import { AgentServer } from '../../src/server/AgentServer.js';

export type TestingIntegrityRequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export type TestingIntegrityRouteMethod = TestingIntegrityRequestMethod | 'ALL';

export interface RouteAliveEvidence {
  method: TestingIntegrityRouteMethod;
  requestMethod?: TestingIntegrityRequestMethod;
  routePath: string;
  requestPath?: string;
  expectedStatus: number;
  headers?: Record<string, string>;
  body?: unknown;
}

const loadModule = createRequire(import.meta.url);
const expressPathToRegexp = loadModule('path-to-regexp') as (routePath: string) => RegExp;

function buildRequest(server: AgentServer, method: TestingIntegrityRequestMethod, requestPath: string): Test {
  const client = request(server.getApp());
  switch (method) {
    case 'GET': return client.get(requestPath);
    case 'POST': return client.post(requestPath);
    case 'PUT': return client.put(requestPath);
    case 'PATCH': return client.patch(requestPath);
    case 'DELETE': return client.delete(requestPath);
    case 'HEAD': return client.head(requestPath);
    case 'OPTIONS': return client.options(requestPath);
  }
}

/**
 * Tier-3 route evidence with an executable oracle.
 *
 * This helper accepts only a real AgentServer instance, sends a real Supertest
 * request through its Express pipeline, asserts an exact non-dead status, and
 * emits proof only after the request completed. The lint guard executes the
 * owning E2E file and consumes that proof; a filename or route string alone can
 * never satisfy the guard.
 */
export async function expectRouteAlive(server: AgentServer, evidence: RouteAliveEvidence) {
  if (!(server instanceof AgentServer)) {
    throw new Error('Testing Integrity evidence requires a real AgentServer instance');
  }
  if (!evidence.routePath.startsWith('/') || !(evidence.requestPath ?? evidence.routePath).startsWith('/')) {
    throw new Error('Testing Integrity route paths must be absolute');
  }
  const requestPath = evidence.requestPath ?? evidence.routePath;
  const pathname = requestPath.split('?')[0];
  if (!expressPathToRegexp(evidence.routePath).test(pathname)) {
    throw new Error(`Testing Integrity request path ${pathname} does not match declared route ${evidence.routePath}`);
  }
  if (evidence.method === 'ALL' && !evidence.requestMethod) {
    throw new Error('Testing Integrity evidence for an ALL route requires a concrete requestMethod');
  }
  if (evidence.method !== 'ALL' && evidence.requestMethod && evidence.requestMethod !== evidence.method) {
    throw new Error(`Testing Integrity request method ${evidence.requestMethod} does not match declared method ${evidence.method}`);
  }
  if (evidence.expectedStatus < 200 || evidence.expectedStatus >= 300) {
    throw new Error(`Testing Integrity requires a live 2xx expected status, received ${evidence.expectedStatus}`);
  }

  const requestMethod = evidence.requestMethod ?? evidence.method as TestingIntegrityRequestMethod;
  let pending = buildRequest(server, requestMethod, requestPath)
    .timeout({ response: 5_000, deadline: 10_000 });
  for (const [name, value] of Object.entries(evidence.headers ?? {})) pending = pending.set(name, value);
  if (evidence.body !== undefined) pending = pending.send(evidence.body);

  const response = await pending;
  expect(response.status).toBe(evidence.expectedStatus);
  expect(response.status).not.toBe(404);
  expect(response.status).not.toBe(503);

  const evidenceFile = process.env.INSTAR_TESTING_INTEGRITY_EVIDENCE_FILE;
  if (evidenceFile) {
    const nonce = process.env.INSTAR_TESTING_INTEGRITY_NONCE;
    if (!nonce) throw new Error('Testing Integrity evidence nonce is unavailable');
    fs.appendFileSync(evidenceFile, `${JSON.stringify({
      nonce,
      method: evidence.method,
      requestMethod,
      path: evidence.routePath,
      requestPath,
      status: response.status,
    })}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  return response;
}
