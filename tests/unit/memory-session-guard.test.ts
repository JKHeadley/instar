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

describe('the fold-probe place (context budget §10 shadow answerer)', () => {
  const probe: SessionTokenRecord = { sessionId: 'inst_probe', audience: { kind: 'system' }, placeKey: 'fold-probe:141133' };

  it('reads its own topic\'s chunk list and chunks', () => {
    expect(memorySessionAllows('GET', '/topic/141133/chunks', probe)).toBe(true);
    expect(memorySessionAllows('GET', '/topic/141133/chunks/span-1', probe)).toBe(true);
  });

  it('never another topic\'s chunks', () => {
    expect(memorySessionAllows('GET', '/topic/999/chunks', probe)).toBe(false);
    expect(memorySessionAllows('GET', '/topic/999/chunks/span-1', probe)).toBe(false);
  });

  it.each([
    ['POST', '/telegram/reply/141133'], ['POST', '/slack/session-reply'], ['POST', '/app/session-reply'],
    ['POST', '/messaging/preflight'], ['POST', '/feedback'], ['POST', '/team/proposals'], ['GET', '/docs'],
    ['GET', '/work-board/cards/wc_0123456789abcdef'], ['GET', '/identity/soul/integrity'], ['GET', '/topic/141133/user-corpus'],
    ['POST', '/topic/141133/chunks'], ['GET', '/topic/search'],
  ])('refuses %s %s, including routes open to any other session', (method, route) => {
    expect(memorySessionAllows(method, route, probe)).toBe(false);
  });

  it('keeps hook plumbing, which carries no remembered content', () => {
    expect(memorySessionAllows('POST', '/hooks/events', probe)).toBe(true);
    expect(memorySessionAllows('GET', '/internal/stop-gate/hot-path', probe)).toBe(true);
  });

  it('no channel session reaches the chunk routes', () => {
    expect(memorySessionAllows('GET', '/topic/141133/chunks', b)).toBe(false);
    expect(memorySessionAllows('GET', '/topic/-100/chunks', group)).toBe(false);
    expect(memorySessionAllows('GET', '/topic/141133/chunks', { ...group, placeKey: 'telegram:141133' })).toBe(false);
  });
});
