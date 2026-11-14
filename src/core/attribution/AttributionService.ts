/**
 * AttributionService.check — one verdict for a piece of text about to be saved or sent.
 * Spec: docs/specs/attribution-paper-trail.md sections 1, 2 and 4.
 *
 * Code computes the exact facts. A marker that does not parse is always refused. A wrong
 * date, a quote not in the record or a missing quote is refused only with the judge running:
 * with no model the text passes as `unchecked`, because a matcher gets no veto when the gate
 * is absent. The judge rules on meaning.
 */
import crypto from 'node:crypto';
import type { AttributionJudge, ExactSignals, ExtractedClaim } from './AttributionJudge.js';
import { neverReachedItsTarget, type AttributionLedger, type AttributionSurface, type ClaimRelation, type LedgerRow } from './AttributionLedger.js';
import { parseMarkers, quoteIsInRecord, type ParsedMarker, type SourceRef } from './marker.js';
import { checkEligibility, type IdentityMap, type RecordStrength } from './recordEligibility.js';
import type { ResolveOutcome, ResolveResult } from './SourceResolver.js';
import type { MessageAuthorship } from '../AspAuthorshipJoin.js';

export type RefusalReason =
  | 'malformed-marker'
  | 'unsourced'
  | 'quote-not-in-record'
  | 'date-mismatch'
  | 'record-not-theirs'
  | 'identity-unverified'
  | 'relayed'
  | 'overstated'
  | 'promoted-unsourced'
  | 'later-than-claim'
  | 'cannot-be-shown';

export interface ClaimFinding {
  span: string;
  person: string | null;
  verdict: 'pass' | 'refuse' | 'unchecked';
  reason?: RefusalReason;
  why?: string;
  outcome?: ResolveOutcome;
  strength?: RecordStrength;
  relation: ClaimRelation;
  ref?: SourceRef;
  /** The source was attached after the claim first appeared. The trace shows this. */
  attachedLater?: boolean;
  /** Machines that did not answer while resolving this claim's source. */
  failed?: string[];
}

export interface CheckResult {
  verdict: 'pass' | 'refuse' | 'unchecked';
  findings: ClaimFinding[];
  malformed: string[];
  /** Ledger rows this check added. */
  written?: LedgerRow[];
}

export interface CheckContext {
  surface: AttributionSurface;
  path?: string;
  /** Lines around the changed text, so a heading change is seen. Defaults to the text. */
  surroundingText?: string;
  recentConversation?: string;
  /** When this claim first appeared, if known. A source newer than this is refused. */
  firstSeen?: string | null;
  /** The source was attached after the claim first appeared, so it only supports the claim. */
  attachedLater?: boolean;
  now?: Date;
  /** Only claims on these lines can be refused or recorded. Absent means the whole text. */
  changedLines?: string[];
  /** The text an Edit replaced, which proves the parent of a reworded claim. */
  oldText?: string;
  /** The marker was already in the note. It is never refused for what cannot be checked now. */
  existingMarkers?: boolean;
  /** False when a refusal is only recorded (`record` mode). */
  enforced?: boolean;
  /** The time a reconstructed root row should carry, when a note's history shows one. */
  rowTime?: string;
}

/** Per-check cap on markers, so one note cannot run up the log reads and judge calls. */
export const MAX_MARKERS_PER_CHECK = 8;

export interface AttributionServiceDeps {
  /** One judge, or one per surface when each surface has its own budget. */
  judge: AttributionJudge | ((surface: AttributionSurface) => AttributionJudge);
  resolve: (ref: SourceRef) => Promise<ResolveResult>;
  identity: IdentityMap;
  ledger: AttributionLedger;
  /** A pin or earlier ledger row already holds this ref, so it may stand without a live row. */
  knownRef?: (ref: SourceRef) => boolean;
  authorship?: (ref: SourceRef, row: Record<string, unknown>) => MessageAuthorship | undefined;
  /** Copies a row on its first verified resolve, so it survives the log rotating it out. */
  pin?: (ref: SourceRef, row: Record<string, unknown>, authorship: MessageAuthorship | undefined) => void;
  /** The first commit holding this text, as an ISO time. The ledger's root wins over this. */
  firstCommitHolding?: (path: string, text: string) => Promise<string | null>;
}

function recordTimestamp(row: Record<string, unknown>): string | null {
  return typeof row.timestamp === 'string' ? row.timestamp : null;
}

function recordText(row: Record<string, unknown>): string {
  return typeof row.text === 'string' ? row.text : '';
}

/** The line holding the span, with its neighbours: the judge rules on the whole line. */
export function surroundingLines(text: string, span: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.includes(span.split('\n')[0]));
  if (at < 0) return span;
  return lines.slice(Math.max(0, at - 1), at + 2).join('\n');
}

/** The quoted words on the line a marker sits on. */
export function quoteBeforeMarker(text: string, marker: ParsedMarker): string | null {
  const lineStart = text.lastIndexOf('\n', marker.index) + 1;
  const before = text.slice(lineStart, marker.index);
  const matches = [...before.matchAll(/["“]([^"”]+)["”]/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end < 0 ? undefined : end);
}

function lineOfSpan(text: string, span: string): string | null {
  const at = text.indexOf(span.split('\n')[0]);
  return at < 0 ? null : lineAt(text, at);
}

export class AttributionService {
  constructor(private readonly deps: AttributionServiceDeps) {}

  async check(text: string, context: CheckContext): Promise<CheckResult> {
    const changed = context.changedLines ? new Set(context.changedLines.map((line) => line.trim())) : null;
    const onChangedLine = (line: string | null) => !changed || line === null || changed.has(line.trim());

    const written: LedgerRow[] = [];
    const record = (row: Parameters<AttributionLedger['record']>[0]) => {
      const { row: stored, written: isNew } = this.deps.ledger.record(row);
      if (isNew) written.push(stored);
      return stored;
    };

    const { markers, malformed: allMalformed } = parseMarkers(text);
    const malformed = allMalformed.filter((bad) => onChangedLine(lineAt(text, bad.index)));
    if (malformed.length) {
      const findings = malformed.map<ClaimFinding>((bad) => ({
        span: bad.raw,
        person: null,
        verdict: 'refuse',
        reason: 'malformed-marker',
        relation: 'unsourced',
      }));
      for (const finding of findings) {
        record({ surface: context.surface, path: context.path, person: 'unnamed', claim: finding.span, kind: 'marker', verdict: 'malformed-marker', relation: 'unsourced', enforced: context.enforced });
      }
      return { verdict: 'refuse', findings, malformed: malformed.map((bad) => bad.raw), written };
    }

    const scanned = context.surroundingText ?? text;
    const judge = typeof this.deps.judge === 'function' ? this.deps.judge(context.surface) : this.deps.judge;
    const claims = await judge.extract(scanned, context.surface === 'send' ? 'send' : 'note', context.recentConversation);
    if (claims === null) {
      // No model, or over budget. The whole text is kept so the audit can judge it later.
      record({
        claimId: `unc_${crypto.createHash('sha256').update(scanned).digest('hex').slice(0, 32)}`,
        surface: context.surface,
        path: context.path,
        person: 'unnamed',
        claim: scanned.slice(0, 200),
        kind: 'unchecked-text',
        verdict: 'unchecked',
        relation: 'unconfirmed',
        context: {
          text: scanned.slice(0, 16_000),
          ...(context.recentConversation ? { recentConversation: context.recentConversation.slice(0, 4_000) } : {}),
          exact: { markers: markers.length, malformed: allMalformed.length },
        },
      });
      return { verdict: 'unchecked', findings: [], malformed: [], written };
    }

    const findings: ClaimFinding[] = [];
    let markersChecked = 0;
    for (const claim of claims) {
      if (!onChangedLine(lineOfSpan(scanned, claim.span))) continue;
      const usesMarker = !claim.labelled && (claim.markerIndex !== null || this.markerOnLineOf(claim, markers, text) !== undefined);
      if (usesMarker && markersChecked >= MAX_MARKERS_PER_CHECK) {
        findings.push({ span: claim.span, person: claim.person, verdict: 'unchecked', relation: 'unconfirmed', why: 'over the per-check marker cap' });
        continue;
      }
      if (usesMarker) markersChecked += 1;

      const person = claim.person ?? 'unnamed';
      const existingId = this.deps.ledger.claimIdFor(person, claim.span);
      const editParent = context.oldText ? this.deps.ledger.parentInText(person, context.oldText) : null;
      const parentClaimId = editParent && editParent !== existingId ? editParent : undefined;
      const lineageRoot = parentClaimId ?? existingId;

      const finding = await this.judgeClaim(claim, markers, text, scanned, context, judge, lineageRoot);
      findings.push(finding);
      record({
        ...(existingId ? { claimId: existingId } : {}),
        ...(parentClaimId ? { parentClaimId, linkedBy: 'edit' as const } : {}),
        surface: context.surface,
        path: context.path,
        person,
        claim: claim.span,
        kind: claim.kind,
        ref: finding.ref,
        quote: this.quoteFor(claim, markers, text),
        verdict: finding.reason ?? finding.verdict,
        reason: finding.why,
        relation: finding.relation,
        strength: finding.strength,
        ...(context.enforced === false ? { enforced: false } : {}),
        ...(context.rowTime ? { ts: context.rowTime } : {}),
      });
    }

    const verdict = findings.some((f) => f.verdict === 'refuse')
      ? 'refuse'
      : findings.some((f) => f.verdict === 'unchecked')
        ? 'unchecked'
        : 'pass';
    return { verdict, findings, malformed: [], written };
  }

  private markerOnLineOf(claim: ExtractedClaim, markers: ParsedMarker[], text: string): ParsedMarker | undefined {
    const line = lineOfSpan(text, claim.span);
    return line === null ? undefined : markers.find((marker) => line.includes(marker.raw));
  }

  private markerFor(claim: ExtractedClaim, markers: ParsedMarker[], text: string): ParsedMarker | undefined {
    const named = claim.markerIndex === null ? undefined : markers[claim.markerIndex];
    return named ?? this.markerOnLineOf(claim, markers, text);
  }

  private quoteFor(claim: ExtractedClaim, markers: ParsedMarker[], text: string): string | undefined {
    const marker = claim.labelled ? undefined : this.markerFor(claim, markers, text);
    return (marker && quoteBeforeMarker(text, marker)) || undefined;
  }

  private async judgeClaim(
    claim: ExtractedClaim,
    markers: ParsedMarker[],
    text: string,
    scanned: string,
    context: CheckContext,
    judge: AttributionJudge,
    lineageRoot: string | null,
  ): Promise<ClaimFinding> {
    const base = { span: claim.span, person: claim.person };
    if (claim.labelled) {
      return claim.stillCredits
        ? { ...base, verdict: 'refuse', reason: 'promoted-unsourced', relation: 'unsourced' }
        : { ...base, verdict: 'pass', relation: 'unsourced' };
    }
    const marker = this.markerFor(claim, markers, text);
    if (!marker) return { ...base, verdict: 'refuse', reason: 'unsourced', relation: 'unsourced' };

    const ref = marker.ref;
    const resolved = await this.deps.resolve(ref);
    const withRef = { ...base, ref, outcome: resolved.outcome, ...(resolved.failed.length ? { failed: resolved.failed } : {}) };

    if (resolved.outcome === 'removed') {
      return { ...withRef, verdict: 'refuse', reason: 'cannot-be-shown', why: 'The person deleted this message.', relation: 'unsourced' };
    }
    if (resolved.outcome === 'unreachable') {
      return { ...withRef, verdict: 'pass', relation: 'unconfirmed' };
    }
    if (resolved.outcome === 'unverifiable' || resolved.outcome === 'not-found') {
      if (context.existingMarkers || this.deps.knownRef?.(ref)) return { ...withRef, verdict: 'pass', relation: 'unconfirmed' };
      return { ...withRef, verdict: 'refuse', reason: 'cannot-be-shown', relation: 'unsourced' };
    }

    const row = resolved.row!;
    if (claim.person === null) return { ...withRef, verdict: 'refuse', reason: 'unsourced', relation: 'unsourced' };
    const authorship = resolved.authorship ?? this.deps.authorship?.(ref, row);
    const eligibility = checkEligibility({
      channel: ref.channel,
      conversation: ref.conversation,
      row,
      person: claim.person,
      identity: this.deps.identity,
      authorship,
    });
    if (!eligibility.eligible) {
      const reason: RefusalReason = eligibility.reason === 'identity-unverified' ? 'identity-unverified' : 'record-not-theirs';
      return { ...withRef, verdict: 'refuse', reason, why: eligibility.reason, relation: 'unsourced' };
    }

    const history = lineageRoot ? this.deps.ledger.chain(lineageRoot, { includeArchives: true }).filter((r) => !neverReachedItsTarget(r)) : [];
    let firstSeen = context.firstSeen;
    if (firstSeen === undefined) {
      firstSeen = history[0]?.ts ?? (context.path && (context.surface === 'note-write' || context.surface === 'audit') && this.deps.firstCommitHolding ? await this.deps.firstCommitHolding(context.path, claim.span) : null);
    }
    const timestamp = recordTimestamp(row);
    if (firstSeen && timestamp && Date.parse(timestamp) > Date.parse(firstSeen)) {
      return { ...withRef, verdict: 'refuse', reason: 'later-than-claim', strength: eligibility.strength, relation: 'reconstructed' };
    }

    const quote = quoteBeforeMarker(text, marker);
    const signals: ExactSignals = {
      markerParsed: true,
      dateMatches: timestamp ? timestamp.slice(0, 10) === ref.date : null,
      quoteInRecord: quote === null ? null : quoteIsInRecord(quote, recordText(row)),
      outcome: resolved.outcome,
      strength: eligibility.strength,
    };
    // A source is the origin only if the marker was there from the claim's first version.
    const rootHadThisRef = history[0]?.ref?.channel === ref.channel && history[0]?.ref?.conversation === ref.conversation && history[0]?.ref?.message === ref.message;
    const attachedLater = context.attachedLater ?? (history.length > 0 && !rootHadThisRef);
    const relation: ClaimRelation = attachedLater || context.surface === 'audit' ? 'reconstructed' : 'origin';
    const ruling = await judge.support(surroundingLines(scanned, claim.span), recordText(row), signals);
    const held = { ...withRef, strength: eligibility.strength, relation, ...(attachedLater ? { attachedLater } : {}) };
    if (!ruling) return { ...held, verdict: 'unchecked' };

    if (ruling.ownWords === 'relayed') return { ...held, verdict: 'refuse', reason: 'relayed', why: ruling.why, relation: 'unsourced' };
    // Evidence requirements for a sourced claim. Only reached with the judge running:
    // with no model the claim passed as unchecked above, because a matcher gets no veto.
    if (signals.quoteInRecord !== true) return { ...held, verdict: 'refuse', reason: 'quote-not-in-record', why: ruling.why, relation: 'unsourced' };
    if (signals.dateMatches === false) return { ...held, verdict: 'refuse', reason: 'date-mismatch', why: ruling.why, relation: 'unsourced' };
    if (ruling.ownWords === 'unclear') return { ...held, verdict: 'unchecked', why: ruling.why };
    if (!ruling.faithful) return { ...held, verdict: 'refuse', reason: 'overstated', why: ruling.why, relation: 'unsourced' };
    if (resolved.outcome === 'found') this.deps.pin?.(ref, row, authorship);
    return { ...held, verdict: 'pass' };
  }
}
