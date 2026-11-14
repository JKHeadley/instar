/**
 * Unowned-handoff detector (B17_FALSE_BLOCKER UNOWNED-HANDOFF signal).
 *
 * SIGNAL ONLY. A cheap, brittle pre-filter that flags outbound text stating that
 * work is NEEDED somewhere else — another repo, the app, another owner — as a
 * scope fact: "will need a small button added to the app", "outside this
 * repository, recorded for the app's owner", "the owner will need to…",
 * "requires a change in the portal repo". It holds NO blocking authority and
 * judges nothing about whether a route was named or the work is needed. The
 * full-context MessagingToneGate LLM is the authority: when this fires, the gate
 * gets the B17 UNOWNED-HANDOFF sub-clause and judges by meaning (route named →
 * pass; not needed for the goal → pass; unsure → pass). A miss just sends the
 * message, which is today's behaviour.
 *
 * Earned 2026-11-10 (Echo Bugs topic 10000002523): inside an approved "fully
 * complete this work" run, an agent wrote exactly those first two sentences
 * with no owner, no handoff and no completion-list item. Every deferral check
 * keyed on "later / follow-up / phase 2" missed it.
 *
 * The same shapes are mirrored in the signal-only deferral-detector hook
 * (PostUpdateMigrator.getDeferralDetectorHook), which cannot import this module.
 */

const UNOWNED_HANDOFF_PATTERNS: readonly RegExp[] = [
  /\boutside (?:of )?(?:this|the|our|my) (?:repo(?:sitory)?|codebase|project)\b/i,
  /\b(?:recorded|noted|left|flagged|parked) for (?:the )?(?:[\w-]+'s )?(?:owner|maintainers?|other team|app team)\b/i,
  /\b(?:the )?(?:[\w-]+'s )?(?:owner|maintainers?|other team|app team) (?:will|would|'ll) need to\b/i,
  /\b(?:will|would) (?:also )?need (?:[\w-]+ ){0,6}(?:in|to|on|into) (?:the |a |another )?(?:app|ios app|android app|mobile app|other repo(?:sitory)?|[\w-]+ repo(?:sitory)?)\b/i,
  /\brequires? (?:a |some )?changes? (?:in|to) (?:the |a |another )?(?:app|ios app|android app|mobile app|other repo(?:sitory)?|[\w-]+ repo(?:sitory)?)\b/i,
];

export interface UnownedHandoffSignal {
  /** True when a cross-boundary "will need" shape is present (a SIGNAL, not a verdict). */
  flagged: boolean;
  /** The first matched text, bounded — for the gate's context. */
  phrase?: string;
}

export function detectUnownedHandoff(text: string): UnownedHandoffSignal {
  if (typeof text !== 'string' || !text) return { flagged: false };
  const normalized = text.replace(/[’‘]/g, "'");
  for (const re of UNOWNED_HANDOFF_PATTERNS) {
    const m = re.exec(normalized);
    if (m) return { flagged: true, phrase: m[0].slice(0, 60) };
  }
  return { flagged: false };
}
