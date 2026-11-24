/** Read-only production composition over declared invented surrounding inputs. */
import fs from 'node:fs';
import express, { type Request } from 'express';
import type { AccountsProductionModules } from './targetProductionModules.js';

export const SURROUNDING_READ_PATHS = ['/mobile/browser-devices/status', '/work-board', '/mobile/health-issues', '/health'] as const;
export type SurroundingState = 'available' | 'disabled' | 'health-error';
export function createAccountsSurroundingReads(production: AccountsProductionModules, nonce: string, now: number, machineId: string, failures: Array<{ detail: string; error: unknown }> = []) {
  const { createBrowserStatusRead } = production.browserStatusRead;
  const { buildHealthBase, healthProjectProjection, formatUptime } = production.healthBaseRead;
  const { mountMobileHealthRoutes } = production.mobileHealthRoutes;
  const { registerWorkBoardRoutes } = production.workBoardRoutes;
  const { WorkBoardService, DEFAULT_WORK_BOARD_SETTINGS } = production.workBoardService;
  const { GATE_ROUTE_VERSION, GATE_ROUTE_MINIMUM_VERSION } = production.stopGate;
  const seed = JSON.parse(fs.readFileSync(new URL('../seeds/accounts-console.json', import.meta.url), 'utf8'));
  let state: SurroundingState = 'available';
  const authenticated = (req: Request) => req.get('Authorization') === `Bearer ${nonce}`;
  const refuseWrite = (): never => { throw new Error('The Accounts fixture refuses mutable companion operations'); };
  const board = new WorkBoardService({
    machineId, emit: refuseWrite, loadUnion: () => structuredClone(seed.workBoard.union), now: () => now,
    settings: () => DEFAULT_WORK_BOARD_SETTINGS, ownerPersonKey: () => null, detectCredential: refuseWrite,
    dayOf: () => ({ day: new Date(now).toISOString().slice(0, 10), resetsAt: new Date(now + 86_400_000).toISOString() }),
    displayName: () => 'Synthetic fixture person',
  });
  board.rebuild();
  const health = (authed: boolean) => {
    if (state === 'health-error') throw new Error('Synthetic health provider unavailable');
    const raw = seed.health;
    const { base } = buildHealthBase({ uptimeMs: raw.uptimeMs, uptimeHuman: formatUptime(raw.uptimeMs),
      sessionExhausted: raw.sessionCount >= raw.maxSessions, totalFailures: raw.currentJobFailures,
      degradations: raw.degradations.length, degradationSummary: () => structuredClone(raw.degradations),
      llmReliability: structuredClone(raw.llmReliability), claudeKeyDead: () => raw.claudeKeyDead,
      gateRouteVersion: GATE_ROUTE_VERSION, gateRouteMinimumVersion: GATE_ROUTE_MINIMUM_VERSION });
    return Object.assign(base, healthProjectProjection(authed, seed.projectName));
  };
  const router = express.Router();
  router.get('/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(health(authenticated(req))); } catch { res.status(503).json({ error: 'fixture-health-provider-unavailable' }); }
  });
  router.get('/mobile/browser-devices/status', createBrowserStatusRead({
    browserOn: () => state !== 'disabled' && seed.browser.enabled, bearerOk: authenticated,
    machineId: () => machineId, nickname: () => null, projectName: () => seed.projectName,
    approvalPath: () => seed.browser.approvalPath, approveEnabled: () => seed.browser.approveEnabled,
    ownerPhoneCanApprove: () => seed.browser.ownerPhoneCanApprove, telegramConfigured: () => seed.browser.telegramConfigured,
    holdsLease: () => seed.browser.holdsLease, telegramOwnerPresent: () => false, keyState: refuseWrite, now: () => now,
  }));
  mountMobileHealthRoutes(router, { reportFailure: (detail, error) => { failures.push({ detail, error }); }, readHealth: async () => ({ status: 200, body: health(true) }), bearerOk: authenticated,
    recentEvents: () => [], current: () => ({}), machine: () => ({ key: machineId, name: null }), now: () => now });
  registerWorkBoardRoutes(router, {
    enabled: () => state !== 'disabled' && seed.workBoard.enabled, svc: () => board, controller: () => null,
    settings: () => DEFAULT_WORK_BOARD_SETTINGS, caller: req => authenticated(req) ? { kind: 'bearer' } : { kind: 'none' },
    ownerPersonKey: () => null, requirePin: refuseWrite, displayName: () => 'Synthetic fixture person',
    appendLine: refuseWrite, ensureConversation: refuseWrite, removeConversation: refuseWrite,
    behind: () => null, lastWrittenOn: () => null, repliedAfterQuestion: () => false, brokenAttachments: () => [],
    when: iso => iso, saveSettings: refuseWrite,
  });
  return { router, failures, setState: (value: SurroundingState) => { state = value; } };
}
