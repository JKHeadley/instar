/**
 * Asking again after a no for a change that matters, or after a long cool-off (docs/specs/recommended-services.md,
 * "Re-offering after a no", reasons 2 and 3). A model judges whether the answer would now differ, but only inside a
 * floor written in code, and only in shadow until it has earned authority: it records what it would do and sends
 * nothing. Real-problem re-offers (reason 1, reoffers.ts) are unaffected.
 *
 * The judge sees categories only: the service, its changes since the no (written by a person in the catalog), the
 * saved reason category, counts, and categorical facts about the agent's use. No conversation text.
 */
import crypto from 'node:crypto';
import type { CatalogRow, ServiceChange } from './catalog.js';
import { isServiceAvailable } from './catalog.js';
import { foldChoice, type LedgerRow, type NoReason, type ReofferRow } from './RecommendedServicesLedger.js';
import type { IntelligenceOptions, IntelligenceProvider } from '../core/types.js';
import { buildBoundedContext, buildStructuredSha256Identity } from '../core/JudgmentProvenanceLog.js';
import { DP_REOFFER_JUDGE } from '../data/provenanceCoverage.js';

/** The component key (one per decision point, census convention). */
export const REOFFER_JUDGE_COMPONENT = 'ReofferJudge';
export const REOFFER_JUDGE_PROMPT_ID = 'reoffer-judge-v1.2';

const DAY_MS = 24 * 60 * 60_000;

/** After this many nos, or this many delivered re-offers of a service, reasons 2 and 3 stop for it. */
export const JUDGED_REOFFER_LIMIT = 3;

/**
 * The re-offer row kind that spends a catalog change. Kinds must match the ledger's id pattern (lower-case letters,
 * digits and hyphens, starting with a letter), so the version is folded into that alphabet.
 */
export function changeKind(version: string): string {
  const v = version.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `change-${v || 'x'}`.slice(0, 64);
}

/** The cool-off before reason 3, after one no and after two or more. */
export function judgedCooloffMs(nos: number): number {
  return nos <= 1 ? 90 * DAY_MS : 180 * DAY_MS;
}

export type JudgedReason = 'change' | 'cool-off';

export interface UseFacts {
  /** Whether the yes page can be reached (a tunnel or the home network). */
  hasAddress: boolean;
  /** Other machines this agent runs on: 0, 1, or 2 for two or more. */
  otherMachines: 0 | 1 | 2;
  /** How many AI doors this agent has switched on. */
  aiDoors: number;
  /** Real-problem kinds recorded in the last 90 days (reoffers.ts), any service. */
  recentProblems: string[];
}

export interface JudgeInput {
  service: string;
  serviceName: string;
  reasonKind: JudgedReason;
  /** The saved reason category on the latest no. */
  noReason: NoReason;
  /** Changes newer than the no that have not yet been spent on a delivered re-offer. Empty for a cool-off. */
  changes: Array<Pick<ServiceChange, 'version' | 'summary' | 'affects'>>;
  nos: number;
  deliveredReoffers: number;
  facts: UseFacts;
}

export const OFFER_WHYS = ['price-change-meets-cost-reason', 'privacy-change-meets-privacy-reason', 'setup-now-simpler', 'new-capability-fits-use', 'use-changed-since-no'] as const;
export const HOLD_WHYS = ['change-misses-reason', 'reason-still-applies', 'no-sign-of-need', 'unsure'] as const;
export type JudgeWhy = (typeof OFFER_WHYS)[number] | (typeof HOLD_WHYS)[number];
export interface JudgeVerdict { verdict: 'offer' | 'hold'; why: JudgeWhy }

/**
 * The floor, in code, which judgment cannot exceed. Returns the reason the judge may be asked about, or why not.
 * `rows` are every ledger row for this service (all owners: the choice is the agent's, not an owner's).
 */
export function judgedFloor(
  row: CatalogRow,
  rows: readonly LedgerRow[],
  reofferRows: readonly ReofferRow[],
  nowMs: number,
): { reason: JudgedReason; changes: ServiceChange[]; nos: number; delivered: number; noReason: NoReason } | { blocked: string } {
  if (!isServiceAvailable(row)) return { blocked: 'unavailable' };
  // The ledger's own fold decides "refused" (a live no beats a yes; a yes supersedes the nos it knew), never the
  // newest timestamp, so two machines with skewed clocks can't disagree with effective().
  const fold = foldChoice(row.id, rows);
  const legacy = rows.filter((r) => r.type === 'legacy-import' && r.service === row.id);
  let noAt: number;
  if (fold.choice === 'no' && fold.at) noAt = Date.parse(fold.at);
  else if (fold.choice === 'unset' && fold.legacyDeclined && legacy.length) noAt = Math.max(...legacy.map((r) => Date.parse(r.at)));
  else return { blocked: 'not-refused' };
  const choices = rows.filter((r) => r.type === 'choice' && r.service === row.id);
  const nos = choices.filter((c) => c.type === 'choice' && c.choice === 'no').length || legacy.length;
  const delivered = reofferRows.filter((r) => r.service === row.id && r.state === 'offered');
  if (nos >= JUDGED_REOFFER_LIMIT || delivered.length >= JUDGED_REOFFER_LIMIT) return { blocked: 'limit-reached' };
  const spent = new Set(delivered.map((r) => r.kind));
  const fresh = (row.changes ?? []).filter((c) => Date.parse(c.at) > noAt && !spent.has(changeKind(c.version)));
  const noReason: NoReason = fold.reason ?? 'none';
  if (fresh.length) return { reason: 'change', changes: fresh, nos, delivered: delivered.length, noReason };
  const lastDelivered = delivered.length ? Math.max(...delivered.map((r) => Date.parse(r.at))) : 0;
  if (nowMs - Math.max(noAt, lastDelivered) >= judgedCooloffMs(nos)) return { reason: 'cool-off', changes: [], nos, delivered: delivered.length, noReason };
  return { blocked: 'cool-off-running' };
}

/** A stable hash of what the judge sees, so a verdict is remembered until something it reads changes. */
export function judgeInputHash(input: JudgeInput): string {
  const { facts, ...rest } = input;
  const stable = { ...rest, facts: { ...facts, recentProblems: [...facts.recentProblems].sort() } };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 32);
}

export function judgePrompt(input: JudgeInput): string {
  const changes = input.changes.length
    ? input.changes.map((c) => `- ${c.version} (${c.affects}): ${c.summary}`).join('\n')
    : '- none (this is a long cool-off, not a change)';
  return [
    'You decide whether an AI agent should ask its owner once more about an optional outside service the owner already declined.',
    'Asking again costs the owner attention and some trust. Only say "offer" when there is a concrete reason to think the answer would now differ. When unsure, say "hold".',
    '',
    `Service: ${input.serviceName}`,
    `Why asking might be considered now: ${input.reasonKind === 'change' ? 'the service changed since the no' : 'a long time has passed since the no'}`,
    `The owner's saved reason for saying no: ${input.noReason}`,
    `Times the owner has said no: ${input.nos}. Times already asked again: ${input.deliveredReoffers}.`,
    'Changes since the no:',
    changes,
    'Facts about how the agent is used:',
    `- the owner can reach its web page: ${input.facts.hasAddress ? 'yes' : 'no'}`,
    `- other machines it runs on: ${input.facts.otherMachines === 2 ? 'two or more' : input.facts.otherMachines}`,
    `- AI providers switched on: ${input.facts.aiDoors}`,
    `- problems seen in the last 90 days: ${input.facts.recentProblems.length ? input.facts.recentProblems.join(', ') : 'none'}`,
    '',
    'What counts as a concrete reason to ask again:',
    '- The change answers the saved reason: a real price cut or a free option for "cost"; a real privacy improvement for "privacy". The owner said no for that reason, and the reason has materially changed, so ask.',
    '- The saved reason is "other" or "none" and the change removes a real burden (setup much simpler, a large price cut).',
    '- After a long time, the facts show a need the service meets: more machines for a networking service, or a recent problem of the kind it fixes (for example "address-repeatedly-down" for an address service).',
    'Not a reason: a change unrelated to the saved reason, a cosmetic or minor change, the owner already having said no twice, or time passing with nothing in the facts that the service would fix.',
    '',
    'First pick the one reason that fits best, then the verdict that goes with it.',
    `Reasons that mean "offer": ${JSON.stringify([...OFFER_WHYS])}`,
    `Reasons that mean "hold": ${JSON.stringify([...HOLD_WHYS])}`,
    'Answer with exactly one JSON object and nothing else, reason first: {"why":"<one reason>","verdict":"offer" or "hold"}. The "why" value must be one of the listed codes, copied exactly, with no other words.',
  ].join('\n');
}

/** Strict parse. Anything else is a failure, which holds and is reported, never treated as a judgment. */
export function parseJudgeVerdict(raw: string): JudgeVerdict | null {
  // The last well-formed answer wins: a model that corrects itself writes the corrected object after the first.
  const objects = raw.match(/\{[^{}]*\}/g) ?? [];
  for (let i = objects.length - 1; i >= 0; i--) {
    let parsed: unknown;
    try { parsed = JSON.parse(objects[i]!); } catch { continue; } // @silent-fallback-ok — an unparseable object is skipped; none valid is a failure, reported by the caller
    if (!parsed || typeof parsed !== 'object') continue;
    const { verdict, why } = parsed as Record<string, unknown>;
    if (verdict === 'offer' && (OFFER_WHYS as readonly string[]).includes(why as string)) return { verdict, why: why as JudgeWhy };
    if (verdict === 'hold' && (HOLD_WHYS as readonly string[]).includes(why as string)) return { verdict, why: why as JudgeWhy };
  }
  return null;
}

/**
 * One judgment. Null on any failure (provider error, timeout, unparseable answer): the caller holds, reports a
 * degradation, and retries later. Never sends, never sets a choice, never chooses message text.
 */
export async function runReofferJudge(intelligence: IntelligenceProvider, input: JudgeInput, opts: { timeoutMs?: number } = {}): Promise<JudgeVerdict | null> {
  const prompt = judgePrompt(input);
  const options: IntelligenceOptions = {
    // The balanced tier: on the labelled bench the fast tier found 2 of 6 offer cases; balanced found 5 of 6 (2026-11-20).
    model: 'balanced',
    maxTokens: 200,
    temperature: 0,
    timeoutMs: opts.timeoutMs ?? 60_000,
    attribution: { component: 'ReofferJudge' }, // = REOFFER_JUDGE_COMPONENT; a literal so the attribution lint can read it
    provenance: {
      decisionPoint: DP_REOFFER_JUDGE,
      context: buildBoundedContext({
        promptIdentitySha256: buildStructuredSha256Identity(prompt),
        service: input.service,
        reasonKind: input.reasonKind,
        noReason: input.noReason,
        changeCount: input.changes.length,
        nos: input.nos,
        deliveredReoffers: input.deliveredReoffers,
      }),
      optionsPresented: ['offer', 'hold'],
      promptId: REOFFER_JUDGE_PROMPT_ID,
    },
  };
  try {
    return parseJudgeVerdict(await intelligence.evaluate(prompt, options));
  } catch {
    return null; // @silent-fallback-ok — a failure holds; the caller reports it as a degradation and retries
  }
}

/** Failures retry with backoff: 1 hour, doubling, at most a day. */
export function judgeRetryAfterMs(failures: number): number {
  return Math.min(DAY_MS, 60 * 60_000 * 2 ** Math.max(0, failures - 1));
}

// ── The labelled bench (spec, "Evidence before authority") ──────────────────────────────────────────────

export interface BenchCase { name: string; input: JudgeInput; expected: 'offer' | 'hold' }

const facts = (over: Partial<UseFacts> = {}): UseFacts => ({ hasAddress: true, otherMachines: 0, aiDoors: 1, recentProblems: [], ...over });
const base = (over: Partial<JudgeInput>): JudgeInput => ({
  service: 'second-ai-door', serviceName: 'A second AI subscription', reasonKind: 'change', noReason: 'cost', changes: [], nos: 1, deliveredReoffers: 0, facts: facts(), ...over,
});

export const REOFFER_JUDGE_BENCH: readonly BenchCase[] = [
  { name: 'cost objection, price dropped', expected: 'offer', input: base({ changes: [{ version: '2027.1', summary: 'The cheapest plan now costs half as much.', affects: 'cost' }] }) },
  { name: 'cost objection, became free', expected: 'offer', input: base({ service: 'jev', serviceName: 'Jev (TypeSafe)', changes: [{ version: '2', summary: 'A free tier now covers normal use.', affects: 'cost' }] }) },
  { name: 'privacy objection, end-to-end encryption added', expected: 'offer', input: base({ service: 'github-state-backup', serviceName: 'GitHub private backup', noReason: 'privacy', changes: [{ version: '2', summary: 'The backup is now encrypted on this machine before it leaves; GitHub cannot read it.', affects: 'privacy' }] }) },
  { name: 'setup objection-free, setup now one tap', expected: 'offer', input: base({ service: 'tailscale', serviceName: 'Tailscale', noReason: 'other', changes: [{ version: '2', summary: 'Setup no longer needs administrator rights; it is one tap.', affects: 'setup' }] }) },
  { name: 'not needed, cool-off, now on three machines', expected: 'offer', input: base({ service: 'tailscale', serviceName: 'Tailscale', noReason: 'not-needed', reasonKind: 'cool-off', facts: facts({ otherMachines: 2 }) }) },
  { name: 'not needed, cool-off, address keeps going down', expected: 'offer', input: base({ service: 'cloudflare-domain', serviceName: 'Cloudflare fixed address', noReason: 'not-needed', reasonKind: 'cool-off', facts: facts({ recentProblems: ['address-repeatedly-down'] }) }) },
  { name: 'cost objection, new dashboard screen', expected: 'hold', input: base({ changes: [{ version: '2027.2', summary: 'A new usage screen in the provider dashboard.', affects: 'capability' }] }) },
  { name: 'privacy objection, price dropped', expected: 'hold', input: base({ service: 'github-state-backup', serviceName: 'GitHub private backup', noReason: 'privacy', changes: [{ version: '2', summary: 'Private repositories got cheaper.', affects: 'cost' }] }) },
  { name: 'have another, cool-off, nothing changed', expected: 'hold', input: base({ service: 'bitwarden', serviceName: 'Bitwarden', noReason: 'have-another', reasonKind: 'cool-off' }) },
  { name: 'cost objection, cool-off only', expected: 'hold', input: base({ reasonKind: 'cool-off' }) },
  { name: 'not needed, cool-off, single machine, no problems', expected: 'hold', input: base({ service: 'tailscale', serviceName: 'Tailscale', noReason: 'not-needed', reasonKind: 'cool-off' }) },
  { name: 'two nos already, setup change', expected: 'hold', input: base({ noReason: 'not-needed', nos: 2, deliveredReoffers: 1, changes: [{ version: '3', summary: 'The sign-in page was redesigned.', affects: 'setup' }] }) },
];

export interface BenchScore { offerRecall: number; falseOfferRate: number; offers: number; holds: number; failures: number; passes: boolean }

/**
 * Scores verdicts against the bench. Gate (spec): at least 80% of the `offer` cases found, at most 5% false
 * offers among the `hold` cases. A failure (null) counts against the judge in both directions: it never passes.
 */
export function scoreBench(cases: readonly BenchCase[], verdicts: ReadonlyArray<JudgeVerdict | null>): BenchScore {
  const offers = cases.filter((c) => c.expected === 'offer');
  const holds = cases.filter((c) => c.expected === 'hold');
  const found = cases.filter((c, i) => c.expected === 'offer' && verdicts[i]?.verdict === 'offer').length;
  const falseOffers = cases.filter((c, i) => c.expected === 'hold' && verdicts[i]?.verdict !== 'hold').length;
  const failures = verdicts.filter((v) => v === null).length;
  const offerRecall = offers.length ? found / offers.length : 0;
  const falseOfferRate = holds.length ? falseOffers / holds.length : 1;
  return { offerRecall, falseOfferRate, offers: offers.length, holds: holds.length, failures, passes: offerRecall >= 0.8 && falseOfferRate <= 0.05 };
}
