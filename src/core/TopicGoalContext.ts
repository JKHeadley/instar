/** Server-owned scope evidence for the existing completion authority. */
import type { TopicIntentStore } from './TopicIntent.js';
import type { InitiativeTracker } from './InitiativeTracker.js';

/** Bounded data, never a deterministic scope verdict. No confidence promotion. */
export function topicGoalContext(
  topicId: string | undefined,
  store?: Pick<TopicIntentStore, 'read'> | null,
  tracker?: Pick<InitiativeTracker, 'list'> | null,
): string | undefined {
  if (!topicId || !/^-?\d+$/.test(topicId) || !Number.isSafeInteger(Number(topicId))) return undefined;
  const canonicalTopicId = String(Number(topicId));
  const file = store?.read(Number(topicId));
  const goals = Object.values(file?.refs ?? {})
    .filter(r => r.status === 'live' && r.kind === 'goal' && r.evidence.some(e => e.userAuthored && e.delta > 0 && ['extract-user', 'user-affirm', 'pending-confirm-positive'].includes(e.kind)))
    .sort((a, b) => (a.sourceTurn ?? 0) - (b.sourceTurn ?? 0));
  // Preserve the original scope AND recent user corrections; never silently
  // replace the whole project with the latest agent-authored next step.
  const selected = goals.length > 12 ? [...goals.slice(0, 6), ...goals.slice(-6)] : goals;
  const linked = (tracker?.list() ?? []).filter(i => i.telegramTopicId === canonicalTopicId &&
    !['completed', 'archived', 'abandoned'].includes(i.status));
  const initiatives = linked.slice(0, 4);
  if (!selected.length && !initiatives.length) return undefined;
  const context = {
    topicId: canonicalTopicId,
    userEvidencedGoals: selected.map(r => ({
      text: r.text.slice(0, 700), textTruncated: r.text.length > 700, sourceTurn: r.sourceTurn,
      // Include polarity: a later user rejection must never become support.
      omittedUserEvidence: Math.max(0, r.evidence.filter(e => e.userAuthored).length - 6),
      userEvidence: r.evidence.filter(e => e.userAuthored).slice(-6).map(e => ({
        kind: e.kind.slice(0, 50), delta: e.delta, at: e.at?.slice(0, 40), sourceMessageId: e.sourceMessageId.slice(0, 100),
      })),
    })),
    omittedGoals: goals.length - selected.length,
    omittedInitiatives: linked.length - initiatives.length,
    initiatives: initiatives.map(i => ({
      title: i.title.slice(0, 200), description: i.description.slice(0, 700),
      textTruncated: i.title.length > 200 || i.description.length > 700,
      status: i.status, phases: i.phases.slice(0, 12).map(p => ({ name: p.name.slice(0, 120), status: p.status })),
      omittedPhases: Math.max(0, i.phases.length - 12),
    })),
  };
  // Escape delimiter-shaped content; keep the complete JSON within a hard
  // prompt budget even for hostile strings. Remove middle goals first so the
  // original anchor and newest correction survive together when possible.
  const encode = () => JSON.stringify(context).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  let encoded = encode();
  while (encoded.length > 16_000 && context.initiatives.length) {
    context.initiatives.pop();
    context.omittedInitiatives++;
    encoded = encode();
  }
  while (encoded.length > 16_000 && context.userEvidencedGoals.length > 1) {
    context.userEvidencedGoals.splice(context.userEvidencedGoals.length > 2 ? 1 : 0, 1);
    context.omittedGoals++;
    encoded = encode();
  }
  return encoded;
}
