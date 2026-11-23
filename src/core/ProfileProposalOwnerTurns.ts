/** Generation-local delivery allowances. Only authenticated ingress may issue one.
 * These handles authorize preparing a question, never applying its settings.
 */
import { randomBytes } from 'node:crypto';
import { DEFAULT_PROFILE_PROPOSAL_TTL_MS } from './ProfileProposalRequests.js';
export interface ProfileProposalOwnerTurnBinding { source: string; principal: string; inboundId: string }
export class ProfileProposalOwnerTurns {
  private handles = new Map<string, { binding: ProfileProposalOwnerTurnBinding; expiresAt: number; reservation?: string; sealed?: boolean }>();
  private inbound = new Map<string, string>();
  private reservations = new Map<string, string>();
  constructor(private readonly options: { now?: () => number } = {}) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private cleanup(): void {
    for (const [handle, entry] of this.handles) if (this.now() >= entry.expiresAt) {
      this.handles.delete(handle);
      this.inbound.delete(JSON.stringify([entry.binding.source, entry.binding.principal, entry.binding.inboundId]));
      if (entry.reservation) this.reservations.delete(entry.reservation);
    }
  }
  /** Trusted ingress supplies the current configured proposal response deadline. */
  issue(binding: ProfileProposalOwnerTurnBinding, expiresAt = this.now() + DEFAULT_PROFILE_PROPOSAL_TTL_MS): string {
    this.cleanup();
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) throw new Error('invalid-owner-turn-deadline');
    if (!binding.source || !binding.principal || !binding.inboundId) throw new Error('invalid-owner-turn');
    const key = JSON.stringify([binding.source, binding.principal, binding.inboundId]);
    const existing = this.inbound.get(key);
    if (existing) return existing;
    const handle = randomBytes(24).toString('hex');
    this.handles.set(handle, { binding: { ...binding }, expiresAt }); this.inbound.set(key, handle);
    return handle;
  }
  canDispatch(handle: string, binding: ProfileProposalOwnerTurnBinding): boolean {
    this.cleanup();
    const entry = this.handles.get(handle);
    return !!entry && !entry.reservation && entry.binding.source === binding.source
      && entry.binding.principal === binding.principal && entry.binding.inboundId === binding.inboundId;
  }
  claim(handle: string, binding: ProfileProposalOwnerTurnBinding): string | null {
    if (!this.canDispatch(handle, binding)) return null;
    const reservation = randomBytes(24).toString('hex');
    this.handles.get(handle)!.reservation = reservation; this.reservations.set(reservation, handle);
    return reservation;
  }
  /** Internal claim lookup. Copy now so later expiry cannot erase an actual dispatched response binding. */
  bindingForClaim(reservation: string): Readonly<ProfileProposalOwnerTurnBinding> | null {
    const handle = this.reservations.get(reservation);
    const entry = handle ? this.handles.get(handle) : undefined;
    if (!entry || entry.reservation !== reservation) return null;
    return Object.freeze({ ...entry.binding });
  }
  /** Actual acceptance or uncertainty makes the delivery reservation irreversible. */
  seal(reservation: string): void {
    const handle = this.reservations.get(reservation);
    if (handle && this.handles.get(handle)?.reservation === reservation) this.handles.get(handle)!.sealed = true;
  }
  /** Call only with positive evidence no platform dispatch happened, never on timeout. */
  releaseBeforeDispatch(reservation: string): boolean {
    this.cleanup();
    const handle = this.reservations.get(reservation);
    if (!handle || this.handles.get(handle)?.sealed || this.handles.get(handle)?.reservation !== reservation) return false;
    delete this.handles.get(handle)!.reservation; this.reservations.delete(reservation); return true;
  }
}
