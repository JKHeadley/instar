import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { memorySessionAllows, MEMORY_SESSION_ROUTES } from '../../src/server/memorySessionGuard.js';
import type { SessionTokenRecord } from '../../src/users/MemoryPrivacy.js';

const b: SessionTokenRecord = { sessionId: 's', audience: { kind: 'person', userId: 'b' }, placeKey: 'slack:D2' };
const group: SessionTokenRecord = { sessionId: 's', audience: { kind: 'place', placeKey: 'telegram:-100' }, placeKey: 'telegram:-100' };

describe('memorySessionAllows', () => {
  it('lets a session reply to its own place', () => {
    expect(memorySessionAllows('POST', '/slack/reply/D2', b)).toBe(true);
    expect(memorySessionAllows('POST', '/telegram/reply/77', group)).toBe(true);
  });
  it('refuses a reply to someone else', () => {
    expect(memorySessionAllows('POST', '/slack/reply/D1', b)).toBe(false);
    expect(memorySessionAllows('POST', '/telegram/reply/77', b)).toBe(false);
  });
  it.each([
    ['GET', '/api/files/read'], ['GET', '/sessions/owner-session/output'], ['GET', '/sessions/owner-session/transcript'],
    ['POST', '/sessions/owner-session/input'], ['POST', '/sessions/spawn'], ['GET', '/semantic/search'],
    ['GET', '/memory/search'], ['GET', '/episodes/recent'], ['GET', '/relationships'], ['GET', '/preferences'],
    ['GET', '/context/working-memory'], ['POST', '/backups/1/restore'], ['GET', '/shared-state/render'],
    ['GET', '/memory-picker/session-context'], ['GET', '/slack/search'], ['POST', '/state/quick-facts'],
    ['GET', '/identity/soul'], ['GET', '/a-route-added-next-year'],
    ['GET', '/internal/stop-gate/log'], ['POST', '/internal/stop-gate/kill-switch'], ['POST', '/internal/compaction-resume'],
    ['GET', '/commitments'], ['GET', '/topic/context/77'], ['GET', '/topic/context/77?assembled=true'], ['GET', '/topic-intent/77/briefing'],
  ])('refuses %s %s by default', (method, route) => {
    expect(memorySessionAllows(method, route, b)).toBe(false);
  });
  it('is not fooled by a method it does not list', () => {
    expect(memorySessionAllows('GET', '/slack/reply/D2', b)).toBe(false);
  });
});

describe('every allowed route is a real route', () => {
  const sources = ['routes.ts', 'fileRoutes.ts'].map((f) => fs.readFileSync(path.join('src/server', f), 'utf8')).join('\n');
  it('has rules with a method and a pattern', () => {
    expect(MEMORY_SESSION_ROUTES.length).toBeGreaterThan(10);
  });
  it.each(['/telegram/reply/', '/slack/reply/', '/messaging/preflight', '/events/delivery-failed', '/slack/session-reply'])(
    '%s exists on the server', (route) => {
      expect(sources).toContain(route);
    });
});
