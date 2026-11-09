/**
 * DiskStewardPoster — writes and sends a machine's disk post (spec docs/specs/disk-steward.md §3.5).
 *
 * Runs only on the lease holder. The text comes from a fixed template and the
 * numbers in the due post; folder names that came from a machine's measurement
 * are cleaned (allowed characters, length, count) and shown in code formatting.
 * No free text from any machine is ever posted. Every line carries its next step.
 */
import { notificationStamper, withNotificationEnvelope } from '../messaging/notificationStampers.js';
import { diskFloorEnvelope, QuietRecordedError } from '../messaging/NotificationSelectivityGate.js';
import type { DuePost, SendOutcome } from './DiskSteward.js';

const stampNotification = notificationStamper('src/monitoring/DiskStewardPoster.ts');
const GiB = 1024 ** 3;

const gib = (b: number): string => {
  const v = b / GiB;
  return v >= 10 ? `${Math.round(v)} GiB` : `${v.toFixed(1)} GiB`;
};

/** Machine-supplied names: only safe characters, at most 60 of them. */
export function cleanName(name: string): string | null {
  const t = name.trim();
  if (!t || t.length > 60 || !/^[A-Za-z0-9._\-/]+$/.test(t) || t.includes('..')) return null;
  return t;
}

/** A machine's display name: letters, digits, spaces and simple punctuation, at most 40 characters. */
export function cleanMachineName(name: string): string | null {
  const t = name.trim().replace(/\s+/g, ' ');
  if (!t || t.length > 40 || !/^[A-Za-z0-9 ._'()\-]+$/.test(t)) return null;
  return t;
}

const CATEGORY_LABEL: Record<string, string> = { 'npm-cache': 'npm cache', 'derived-data': 'Xcode build files' };

function ago(ms: number): string {
  const h = Math.round(ms / 3_600_000);
  return h < 1 ? 'just now' : h === 1 ? '1 h ago' : `${h} h ago`;
}

export function renderPost(post: DuePost, now: number = Date.now()): string {
  const name = cleanMachineName(post.machineName) ?? post.machineId.slice(0, 12);
  const pct = post.total > 0 ? Math.round((post.free / post.total) * 100) : 0;
  const lines: string[] = [];
  if (post.kind === 'recovery') {
    lines.push(`${name}: back to normal, ${gib(post.free)} free of ${gib(post.total)} (${pct}%).`);
    return lines.join('\n');
  }
  let head = `${name}: ${gib(post.free)} free of ${gib(post.total)} (${pct}%)`;
  if (post.change24h !== null && Math.abs(post.change24h) >= 0.5 * GiB) head += post.change24h < 0 ? `, down ${gib(-post.change24h)} in the last day` : `, up ${gib(post.change24h)} in the last day`;
  head += '.';
  if (post.critical) head += ' This is at or near the point where uploads are refused (5% free).';
  else if (post.daysToFloor !== null && post.daysToFloor < 14) head += ` At this rate it reaches the danger line (5%) in about ${Math.max(1, Math.round(post.daysToFloor))} day${Math.round(post.daysToFloor) === 1 ? '' : 's'}.`;
  lines.push(head);

  if (post.cleared.length) {
    const total = post.cleared.reduce((a, c) => a + c.bytes, 0);
    lines.push(`I cleared ${gib(total)} just now: ${post.cleared.map((c) => `${CATEGORY_LABEL[c.category] ?? c.category} ${gib(c.bytes)}`).join(', ')}.`);
  }
  if (post.cleanupNotHelping) lines.push('Automatic cleanup is not freeing enough, so it is paused until space recovers.');
  if (post.cacheReclaimableBytes >= 0.5 * GiB) {
    lines.push(`To clear ${gib(post.cacheReclaimableBytes)} of npm cache and Xcode build files now, reply "clear disk on ${name}".`);
  }
  const wt = post.worktrees;
  if (wt) {
    if (wt.reclaimable > 0) {
      const size = wt.reclaimableBytes !== null ? ` (${gib(wt.reclaimableBytes)})` : '';
      lines.push(post.reaperArmed
        ? `Finished worktrees: ${wt.reclaimable}${size}; the worktree cleaner removes them on its next pass.`
        : `Finished worktrees: ${wt.reclaimable}${size} the worktree cleaner can remove; it is switched off on ${name}, and I can turn it on if you ask.`);
    }
    const inUse = wt.kept['in-use'] ?? 0;
    const dirty = wt.kept['uncommitted-changes'] ?? 0;
    const parts: string[] = [];
    if (inUse) parts.push(`${inUse} in use or linked to by other checkouts`);
    if (dirty) parts.push(`${dirty} with work or leftovers I can't prove are safe (tracked)`);
    if (parts.length) lines.push(`Worktrees kept on purpose: ${parts.join(', ')}.`);
  }
  const big = (post.biggest ?? []).map((f) => ({ n: cleanName(f.name), b: f.bytes })).filter((f) => f.n).slice(0, 3);
  if (big.length) {
    const when = post.sizesAt ? ` (sized ${ago(now - post.sizesAt)}${post.sizesPartial ? ', partial: at least these' : ''})` : '';
    lines.push(`Biggest folders: ${big.map((f) => `\`${f.n}\` ${gib(f.b)}`).join(', ')}${when}.`);
  }
  if (!post.pruneEnabled && !post.cleared.length && post.cacheReclaimableBytes < 0.5 * GiB) {
    lines.push('Nothing here is safe for me to clear automatically; the folders above are where the space is.');
  }
  return lines.join('\n');
}

export interface PosterDeps {
  resolveTopicId: () => Promise<number | null>;
  sendToTopic: (topicId: number, text: string) => Promise<unknown>;
  log: (e: Record<string, unknown>) => void;
}

export function makeDiskStewardSender(deps: PosterDeps): (post: DuePost) => Promise<SendOutcome> {
  return async (post) => {
    const topicId = await deps.resolveTopicId();
    if (topicId === null) { deps.log({ event: 'post-no-topic', postId: post.postId }); return 'failed'; }
    const text = renderPost(post);
    try {
      if (post.critical && post.kind !== 'recovery') {
        await withNotificationEnvelope(diskFloorEnvelope(post.machineId, post.episodeStart, post.stage), async () => deps.sendToTopic(topicId, text));
      } else {
        await withNotificationEnvelope(stampNotification(), async () => deps.sendToTopic(topicId, text));
      }
    } catch (e) {
      // The gate decided to record it quietly (the operator's push choice): that
      // counts as posted; resending would not change the decision (§3.5).
      if (e instanceof QuietRecordedError) {
        deps.log({ event: 'recorded-quiet', postId: post.postId, machineId: post.machineId, quietId: e.receipt.quietId });
        return 'posted';
      }
      throw e;
    }
    deps.log({ event: 'posted', postId: post.postId, machineId: post.machineId, kind: post.kind, level: post.level, critical: post.critical });
    return 'posted';
  };
}
