import fs from 'node:fs';
import path from 'node:path';
import type { ProposeResult } from './AccountPathService.js';

export interface ApprovalPresentation {
  version: 1;
  status: 'sent' | 'awaiting-acceptance' | 'available-in-app' | 'unconfirmed' | 'not-opened';
  surface: 'direct-chat' | 'accepted-device' | 'none';
}

/** Self-contained: the canonical hook generator embeds this exact runtime validator. */
export function isActionableApproval(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const a = value as Record<string, unknown>;
  return a.version === 1 && ((a.status === 'sent' || a.status === 'awaiting-acceptance') && a.surface === 'direct-chat'
    || a.status === 'available-in-app' && a.surface === 'accepted-device');
}

export function approvalPresentation(ask?: ProposeResult): { action: 'ask' | 'block'; approval: ApprovalPresentation; reason: string } {
  if (ask?.status === 'sent') {
    const app = ask.via === 'device';
    return { action: 'ask', approval: { version: 1, status: app ? 'available-in-app' : 'sent', surface: app ? 'accepted-device' : 'direct-chat' },
      reason: app ? 'This request is available to approve on a currently accepted owner device. Chat delivery is not required or claimed.' : 'The approval request is saved and its card was delivered to the current owner. Nothing runs until they approve it.' };
  }
  if (ask?.status === 'awaiting-acceptance') return { action: 'ask', approval: { version: 1, status: 'awaiting-acceptance', surface: 'direct-chat' }, reason: 'The request is saved and the current owner received the acceptance message. Their authenticated acceptance is needed before the approval card can follow.' };
  return { action: 'block', approval: { version: 1, status: ask?.status === 'delivery-unconfirmed' || ask?.status === 'undelivered' ? 'unconfirmed' : 'not-opened', surface: 'none' },
    reason: ask && 'message' in ask ? ask.message : 'No actionable approval request could be confirmed. This action remains refused; it is not waiting on the owner.' };
}

/** Bounded local evidence; failed storage never turns a refusal into permission. */
export function traceApprovalRefusal(stateDir: string, outcome: { status: string; reason?: string; machine: string; disposition: string }): boolean {
  try {
    const dir = path.join(stateDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'approval-refusals.jsonl'), JSON.stringify({ ...outcome, reason: outcome.reason ?? outcome.status, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    return true;
  } catch { return false; } // @silent-fallback-ok: caller retains refusal and explains unavailable trace
}
