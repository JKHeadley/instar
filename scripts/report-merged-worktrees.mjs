#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const DAY = 86_400_000;
const GUARDS = [
  'registered', 'clean', 'unlocked', 'ownerClear',
  'noLiveUse', 'noDependencies', 'noNestedCheckout',
];

try {
  const [, , file, time, ...extra] = process.argv;
  if (!file || extra.length) throw new Error('Usage: node scripts/report-merged-worktrees.mjs SNAPSHOT.json [ISO_TIME]');
  const now = time === undefined ? Date.now() : Date.parse(time);
  const input = JSON.parse(readFileSync(file, 'utf8'));
  if (!Number.isFinite(now) || typeof input?.host !== 'string' || !input.host.trim() ||
      !Array.isArray(input.worktrees)) throw new Error('Expected host, worktrees and a valid evaluation time');
  const seen = new Set();
  const worktrees = input.worktrees.map((row) => {
    if (typeof row?.path !== 'string' || !row.path.trim() || seen.has(row.path)) {
      throw new Error('Expected a distinct nonempty path for each checkout');
    }
    seen.add(row.path);
    const e = row.evidence;
    const reasons = [];
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row.head ?? '') ||
        typeof row.generation !== 'string' || !row.generation.trim() ||
        e?.head !== row.head || e?.generation !== row.generation) reasons.push('checkout-generation-unverified');
    if (!Number.isFinite(e?.observedAt) || !Number.isFinite(e?.validUntil) ||
        e.observedAt > now || e.validUntil <= now) reasons.push('evidence-stale-or-unavailable');
    if (e?.trustedMergedPr !== true || !Number.isFinite(e?.mergedAt) ||
        !Number.isFinite(e?.observedAt) || e.mergedAt > e.observedAt) reasons.push('merged-pr-unverified');
    else if (now - e.mergedAt < DAY) reasons.push('merge-less-than-24-hours-ago');
    if (!Number.isFinite(e?.verifiedIdleMs) || e.verifiedIdleMs < DAY) reasons.push('24-hour-idle-unverified');
    for (const guard of GUARDS) if (e?.guards?.[guard] !== true) reasons.push(guard + '-unverified');
    return { path: row.path, head: row.head ?? null, verdict: reasons.length ? 'hold' : 'would-release',
      reasons, archiveNeeded: typeof e?.archiveNeeded === 'boolean' ? e.archiveNeeded : null };
  });
  console.log(JSON.stringify({ host: input.host, evaluatedAt: new Date(now).toISOString(),
    mode: 'report-only', worktrees }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
