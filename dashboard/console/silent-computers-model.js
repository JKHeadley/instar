// Pure read model shared by the Needs source and the Machines panel. No owner action authority.
import { verifiedDisplayName } from './display-identity.js';

export function silentComputerReviewModel(res) {
  const unknown = () => ({ state: 'unknown' });
  if (res?.status === 503 || res?.reason === 'switched off on this agent') return { state: 'off' };
  if (!res?.ok || !res.data || typeof res.data.enabled !== 'boolean') return unknown();
  const d = res.data;
  if (!d.enabled) return { state: 'off' };
  if (typeof d.show !== 'boolean' || typeof d.evidenceComplete !== 'boolean' || typeof d.heldBack !== 'boolean') return unknown();
  if (!d.show) return { state: 'hidden', incomplete: !d.evidenceComplete };
  if (!Array.isArray(d.rows) || !d.rows.length || !/^[a-f0-9]{16}$/i.test(d.fingerprint || '')) return unknown();
  if (d.rows.some(r => !r || typeof r.machineId !== 'string' || typeof r.confirmedGone !== 'boolean')) return unknown();
  return {
    state: 'review', fingerprint: d.fingerprint, incomplete: !d.evidenceComplete,
    heldBack: d.heldBack === true,
    rows: d.rows.map(r => ({
      name: verifiedDisplayName(r.name, r.machineId) || 'A computer whose name is unavailable',
      confirmedGone: r.confirmedGone,
      // Preserve raw time only inside this model; do not use absence as proof.
      silentSince: typeof r.silentSince === 'string' && Number.isFinite(Date.parse(r.silentSince)) ? r.silentSince : null,
    })),
  };
}

