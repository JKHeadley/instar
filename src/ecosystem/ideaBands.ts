/**
 * Band rules, the effect-class floor and the funnel
 * (docs/specs/ecosystem-idea-pipeline.md §7, §10). Trusted code applies these to recorded
 * fields, some of which are model judgments. Newness earns nothing, and a low class earns
 * nothing on its own.
 */
import { recordHash } from './EcosystemLedger.js';
import type { Band, EffectClass, GapRead, GapVerdict, Idea } from './types.js';

const CLASS_RANK: Record<EffectClass, number> = { 'additive-dark': 0, 'behaviour-changing': 1, 'reduces-capability': 2 };

/** A deliberately broad floor that can only raise a burden, never decide anything else. */
const FLOOR_RE = /\b(session[- ]start|startup (file|instructions|context)|context (budget|size|limit|cap|reduction)|preamble|what agents? loads?|tool (permission|allowlist|limit|restriction|grant)|allowed ?tools|sandbox|remov(e|es|ing|al of) (a|the|this)? ?(step|check|gate|review)|skip(s|ping)? (a|the)? ?(step|check|gate|review))/i;

export function higherClass(a: EffectClass, b: EffectClass): EffectClass {
  return CLASS_RANK[a] >= CLASS_RANK[b] ? a : b;
}

/** Two blind reads: the higher class wins, and the floor can raise it further. */
export function floorClass(reads: EffectClass[], claim: string): EffectClass {
  let out: EffectClass = 'additive-dark';
  for (const r of reads) out = higherClass(out, r);
  if (reads.length === 0) out = 'behaviour-changing';
  return FLOOR_RE.test(claim) ? higherClass(out, 'behaviour-changing') : out;
}

/** Disagreement between reads, or a failed citation, gives `unverified`, which cannot rank. */
export function reconcileVerdict(first: GapRead | null, second: GapRead | null): GapVerdict {
  if (!first || !second) return 'unverified';
  if (first.verdict === 'unverified' || second.verdict === 'unverified') return 'unverified';
  return first.verdict === second.verdict ? first.verdict : 'unverified';
}

/** An operator's lowering counts only for the revision it was made on. */
export function effectiveClass(idea: Idea): EffectClass | null {
  const lowered = latestDecision(idea, 'lower-class');
  return idea.classLoweredTo && lowered?.recordHash === recordHash(idea) ? idea.classLoweredTo : idea.effectClass;
}

export function latestDecision(idea: Idea, action?: string) {
  const list = action ? idea.decisions.filter((d) => d.action === action) : idea.decisions;
  return list.length ? list[list.length - 1] : null;
}

/** A decline stands until a sighting adds evidence at a new commit. */
export function isDeclined(idea: Idea): boolean {
  const d = latestDecision(idea, 'decline');
  return !!d && d.recordHash === recordHash(idea);
}

export function bandOf(idea: Idea, nowMs: number = Date.now()): { band: Band; reason: string } {
  if (isDeclined(idea)) return { band: 'stopped', reason: 'declined by the operator' };
  const verdict = idea.verdict;
  if (idea.stage !== 'done' || !verdict) return { band: 'unranked', reason: `still in review (${idea.stage})` };
  if (verdict === 'unverified') return { band: 'unranked', reason: 'the two reads disagreed or a citation failed, so it cannot rank' };
  if (verdict === 'have-it') return { band: 'stopped', reason: 'Instar already has this' };
  if (verdict === 'not-for-us') return { band: 'stopped', reason: 'conflicts with what Instar is' };
  const goal = idea.goal;
  if (!goal) return { band: 'watch', reason: 'no goal review on record' };
  if (goal.unhindered.addsLimit && !goal.unhindered.namedRule) return { band: 'stopped', reason: 'adds a limit that names no rule' };
  for (const [name, part] of [['coherence', goal.coherence], ['trust', goal.trust]] as const) {
    if (part.effect === 'harms') return { band: 'stopped', reason: `the review says it harms ${name}` };
  }
  if (goal.instar2.status === 'conflict') return { band: 'stopped', reason: 'conflicts with the Instar 2.0 design' };
  if (goal.goalFit === 'none') return { band: 'stopped', reason: 'no fit with the goals' };

  const latest = idea.sightings[idea.sightings.length - 1];
  const young = !latest || latest.maturity === 'prose-only' || (latest.ageDays !== null && latest.ageDays < 14);
  if (young) return { band: 'watch', reason: 'young or unproven at the source' };

  const reads = [idea.firstRead, idea.secondRead];
  const twoFamilies = reads.every((r) => r && !r.singleFamily);
  const byMeaning = reads.every((r) => r && r.searchMode === 'hybrid');
  const cheap = goal.evidenceCost === 'available' || goal.evidenceCost === 'cheap';
  const cls = effectiveClass(idea);
  void nowMs;
  if (goal.goalFit === 'clear' && twoFamilies && byMeaning && cheap && cls !== 'reduces-capability') {
    return { band: 'now', reason: 'verified by two families, clear goal fit, evidence available or cheap' };
  }
  const why = !twoFamilies ? 'only one model family read it'
    : !byMeaning ? 'the search was by word only'
      : cls === 'reduces-capability' ? 'it takes something away, so it needs a trial first'
        : !cheap ? 'evidence still to be gathered' : 'goal fit is partial';
  return { band: 'plan', reason: why };
}

const FIT: Record<string, number> = { clear: 0, some: 1, none: 2 };
const SIZE: Record<string, number> = { large: 0, medium: 1, small: 2 };
const EFFORT: Record<string, number> = { s: 0, m: 1, l: 2 };

export function compareWithinBand(a: Idea, b: Idea): number {
  return (FIT[a.goal?.goalFit ?? 'none'] - FIT[b.goal?.goalFit ?? 'none'])
    || (SIZE[a.goal?.gapSize ?? 'small'] - SIZE[b.goal?.gapSize ?? 'small'])
    || (EFFORT[a.goal?.effort ?? 'l'] - EFFORT[b.goal?.effort ?? 'l'])
    || a.id.localeCompare(b.id);
}

export interface Funnel {
  seen: number; verified: number; bands: Record<Band, number>; decided: number; adopted: number;
  lastAdoptionAt: string | null; overturnedInAudit: number; audited: number;
}

export function funnelOf(ideas: Idea[], nowMs: number = Date.now()): Funnel {
  const bands: Record<Band, number> = { now: 0, plan: 0, watch: 0, stopped: 0, unranked: 0 };
  let verified = 0, decided = 0, adopted = 0, overturned = 0, audited = 0;
  let lastAdoptionAt: string | null = null;
  for (const idea of ideas) {
    bands[bandOf(idea, nowMs).band]++;
    if (idea.verdict && idea.verdict !== 'unverified') verified++;
    if (idea.decisions.length) decided++;
    if (idea.adoption) { adopted++; if (!lastAdoptionAt || idea.adoption.at > lastAdoptionAt) lastAdoptionAt = idea.adoption.at; }
    if (idea.audit) { audited++; if (idea.audit.overturned) overturned++; }
  }
  return { seen: ideas.length, verified, bands, decided, adopted, lastAdoptionAt, overturnedInAudit: overturned, audited };
}
