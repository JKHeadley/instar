/**
 * Removing a device that can approve (identity-security piece 3a §6; mobile-approver-mark §3.5).
 *
 * The dashboard or the agent's token alone can't disable an approving device where a private chat exists: the
 * removal answers 202 pending-owner-confirm, and the device keeps its right until the owner taps Approve in the
 * private chat. The tap revokes the device record on this machine (and every machine, through the key ledger).
 * The last device that can approve can't be removed until recovery exists (piece 3d).
 */
import crypto from 'node:crypto';
import type { MobilePairingService } from './mobilePairingRoutes.js';
import { approverPresenceKey, liveOwnerKeys, retireApprovalKey } from './mobileApprover.js';
import { dropApproverClaimFor } from './mobileApproverClaim.js';

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING = 20;
const pending = new Map<string, { deviceId: string; at: number }>();

function prune(now: number): void {
  for (const [n, p] of pending) if (now - p.at >= PENDING_TTL_MS) pending.delete(n);
}

/** True when the device's key is the record's only owner key (§6: refused until recovery exists). */
export function isLastOwnerKey(svc: MobilePairingService, deviceId: string): boolean {
  const key = approverPresenceKey(svc, deviceId);
  if (!key) return false;
  const live = liveOwnerKeys(svc);
  return live.length <= 1 && live.some((k) => k.publicKey === key);
}

export type ApproverRevokeAsk = { kind: 'sent' } | { kind: 'no-private-chat' } | { kind: 'unavailable' } | { kind: 'too-many' };

/** §6: ask the owner, in the private chat, to confirm removing an approving device. */
export async function askOwnerToRevokeApprover(svc: MobilePairingService, deviceId: string, now = Date.now()): Promise<ApproverRevokeAsk> {
  if (svc.approvalPath() !== 'telegram' || !svc.deps.ownerDM) return { kind: 'no-private-chat' };
  prune(now);
  for (const [n, p] of pending) if (p.deviceId === deviceId) pending.delete(n); // one live ask per device
  if (pending.size >= MAX_PENDING) return { kind: 'too-many' };
  const nonce = crypto.randomBytes(12).toString('hex');
  const d = svc.devices.get(deviceId);
  const name = d?.label ?? d?.deviceName ?? 'A device';
  const text = `Someone asked to remove ${name} (${d?.fingerprint ?? deviceId}), a device that approves changes to ${svc.deps.config.projectName ?? 'this agent'}. Tap Approve to remove it. Tap Decline to keep it. If you didn't ask for this, tap Decline.`;
  pending.set(nonce, { deviceId, at: now });
  let sent: number | null = null;
  try { sent = await svc.deps.ownerDM(text, `md:d:${nonce}`, `md:a:${nonce}`); } catch { sent = null; /* @silent-fallback-ok: answered as unavailable; the device keeps its right */ }
  if (sent === null) { pending.delete(nonce); return { kind: 'unavailable' }; }
  return { kind: 'sent' };
}

/** Whether a private-chat tap belongs to a pending approver removal. */
export function isApproverRevokeNonce(nonce: string): boolean { prune(Date.now()); return pending.has(nonce); }

/**
 * The owner's tap. Approve revokes the device record here (the caller's revoke function also writes the key
 * ledger, which carries it to every machine). Decline keeps the device.
 */
export function takeApproverRevokeTap(svc: MobilePairingService, nonce: string, approve: boolean, revoke: (deviceId: string) => boolean): { text: string; done: boolean } {
  const p = pending.get(nonce);
  pending.delete(nonce);
  if (!p) return { text: 'This request has already ended.', done: false };
  if (!approve) return { text: 'Kept. That device can still approve.', done: false };
  // Checked again now, when it takes effect: two removals asked one after the other must not leave nothing that approves.
  if (isLastOwnerKey(svc, p.deviceId)) return { text: 'Not removed: it is the only device that can approve. Add another one first.', done: false };
  const key = approverPresenceKey(svc, p.deviceId);
  let retired = false;
  let ok = false;
  try {
    // The key is retired first, so the phone can't come back by pairing again and registering the same key.
    if (key) { retireApprovalKey(svc.deps.stateDir, key); retired = true; }
    ok = revoke(p.deviceId);
  } catch { ok = false; /* @silent-fallback-ok: answered below; the owner can ask again */ }
  if (ok) dropApproverClaimFor(p.deviceId);
  if (ok) return { text: 'Removed. That device can no longer approve here, and your other computers stop accepting its key at their next check-in.', done: true };
  return retired
    ? { text: 'That device can no longer approve, but it is still paired. Remove it again from the Phones page.', done: false }
    : { text: 'That device could not be removed. Try again from the Phones page.', done: false };
}

export function resetApproverRevokeForTests(): void { pending.clear(); }
