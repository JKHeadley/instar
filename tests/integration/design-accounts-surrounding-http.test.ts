import { afterEach, describe, expect, it } from 'vitest';
import { startAccountsHarness } from '../design/harness/accountsServer.js';
const stops: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); });
describe('real surrounding read composition for the Accounts console', () => {
 it('derives explicit unavailable health and read-only capabilities without claiming owner or send access', async () => {
  const h = await startAccountsHarness(); stops.push(h.close);
  const headers = { Authorization: `Bearer ${h.bootNonce}` };
  const browser = await fetch(`${h.url}/mobile/browser-devices/status`, { headers }); expect(browser.status).toBe(200);
  expect(await browser.json()).toMatchObject({ enabled: true, approvalPath: 'dashboard', approveEnabled: false, ownerPhoneApproves: false, telegramSend: false });
  const board = await fetch(`${h.url}/work-board`, { headers }); expect(board.status).toBe(200);
  const health = await fetch(`${h.url}/health`, { headers }); expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({ status: 'degraded', project: 'Synthetic Accounts Fixture', llmReliability: { status: 'unavailable' } });
  const detail = await fetch(`${h.url}/mobile/health-issues`, { headers }); expect(detail.status).toBe(200);
  expect((await detail.json()).verdict).not.toBe('healthy');
 });
 it('does not expose authenticated fixture projections or mutable companion routes to unbound requests', async () => {
  const h = await startAccountsHarness(); stops.push(h.close);
  for (const [route, status] of [['/mobile/browser-devices/status', 403], ['/work-board', 401], ['/mobile/health-issues', 403]] as const) expect((await fetch(h.url + route)).status).toBe(status);
  expect(await fetch(`${h.url}/health`).then(r => r.json())).not.toHaveProperty('project');
  for (const route of ['/work-board/cards', '/mobile/browser-devices', '/mobile/health-issues/choices']) expect((await fetch(h.url + route, { method: 'POST' })).status).toBeGreaterThanOrEqual(400);
 });
});

describe('actual surrounding disabled and failing branches', () => {
 it('preserves production disabled statuses rather than inventing successful capability probes', async () => {
  const h = await startAccountsHarness('busy', { surroundingState: 'disabled' }); stops.push(h.close);
  const headers = { Authorization: `Bearer ${h.bootNonce}` };
  const browser = await fetch(`${h.url}/mobile/browser-devices/status`, { headers }); expect(browser.status).toBe(503);
  expect(await browser.json()).toMatchObject({ error: 'browser-devices-off' });
  const board = await fetch(`${h.url}/work-board`, { headers }); expect(board.status).toBe(503);
  expect(await board.json()).toEqual({ error: 'work-board-disabled' });
 });
 it('uses the actual mobile-health error branch and privately records its real failure', async () => {
  const h = await startAccountsHarness('busy', { surroundingState: 'health-error' }); stops.push(h.close);
  const headers = { Authorization: `Bearer ${h.bootNonce}` };
  expect((await fetch(`${h.url}/health`, { headers })).status).toBe(503);
  const response = await fetch(`${h.url}/mobile/health-issues`, { headers }); expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: 'health-unavailable', verdict: 'unsure', reason: 'summary-failed' });
  expect(h.surroundingFailures).toHaveLength(1);
  expect(h.surroundingFailures[0].detail).toBe('GET /mobile/health-issues');
  expect(h.surroundingFailures[0].error).toBeInstanceOf(Error);
  expect((h.surroundingFailures[0].error as Error).message).toBe('Synthetic health provider unavailable');
 });
});
