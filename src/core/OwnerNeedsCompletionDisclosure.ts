import { z } from 'zod';
import { canonicalHash } from './GraphWitnessTypes.js';

const ref = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const item = z.strictObject({
  project: ref,
  bindingVersion: ref,
  episode: ref,
  evidenceRevision: hash,
  title: z.string().trim().min(1).max(200),
  outcome: z.string().trim().min(1).max(500),
});
const disclosure = z.strictObject({
  id: ref,
  owner: ref,
  items: z.array(item).min(1).max(20),
});
const choice = z.strictObject({
  episode: ref,
  decision: z.enum(['approve', 'decline']),
});
const choices = z.array(choice).min(1).max(20);

export type OwnerNeedsCompletionDisclosure = z.infer<typeof disclosure>;

export function parseOwnerNeedsCompletionDisclosure(value: unknown): OwnerNeedsCompletionDisclosure | null {
  const parsed = disclosure.safeParse(value);
  if (!parsed.success) return null;
  const result = parsed.data;
  if (new Set(result.items.map(entry => entry.project)).size !== result.items.length
    || new Set(result.items.map(entry => entry.episode)).size !== result.items.length) return null;
  return result;
}

/** Bind one in-place submission to its exact shown projects, evidence and answered choices. */
export function ownerNeedsCompletionBinding(value: unknown, submittedChoices: unknown) {
  const shown = parseOwnerNeedsCompletionDisclosure(value);
  const submitted = choices.safeParse(submittedChoices);
  if (!shown || !submitted.success) return null;
  const answered = new Map(submitted.data.map(answer => [answer.episode, answer.decision]));
  if (answered.size !== submitted.data.length) return null;

  const decisions = shown.items.flatMap(entry => {
    const decision = answered.get(entry.episode);
    return decision ? [{
      ...entry, decision,
      requestKey: canonicalHash(['owner-project-completion-request-v1', entry.project, entry.bindingVersion, entry.episode]),
    }] : [];
  });
  if (decisions.length !== answered.size) return null;
  return {
    purpose: 'owner-needs-project-completion-v1' as const,
    disclosureDigest: canonicalHash(shown),
    actionBindingDigest: canonicalHash(['owner-needs-project-completion-v1', shown.id, shown.owner, decisions]),
    decisions,
  };
}
