/**
 * ApprenticeshipMatrixAcceptance — the §2.2 acceptance-authority machinery for
 * the stall-coverage matrix gate (PR-B).
 *
 * Spec: docs/specs/framework-stall-coverage-matrix.md §2.2, Frontloaded
 * Decisions 14 + 20.
 *
 * ONE acceptance artifact shape everywhere:
 *   { contentHash, enumerated row ids, authenticated principal, challenge ref }
 * minted via the SAME server-enumerates → operator-replies challenge mechanic
 * as the existing autonomous ratify-deferral flow (ScopeAccretionRatifier):
 * the server renders the exact enumerated set, the operator's authenticated
 * reply (dashboard-PIN route OR a reply-anchored verified-operator Telegram
 * confirmation) binds exactly that set, and the challenge is SINGLE-USE —
 * replay refused.
 *
 * Binding granularity (Decision 20): a ROW-SCOPED acceptance binds its
 * contentHash to the canonical serialization of exactly the accepted rows (a
 * codemod adding UNRELATED rows does not void it); a WHOLE-SET transition
 * acceptance binds the whole-matrix content hash (re-review on ANY change is
 * the intent); a per-instance OVERRIDE additionally binds to the named
 * rule/row and expires on any change to that row.
 *
 * Requester ≠ acceptor STRUCTURALLY (Decision 14): binding requires an
 * authenticated principal kind — 'operator-pin' (the dashboard-PIN route) or
 * 'verified-operator' (the reply-anchored Telegram path). A 'bearer' principal
 * — the transition caller's own token — is REFUSED at the bind chokepoint, so
 * self-approval cannot be recorded by construction.
 *
 * Persistence: pending challenges live in
 * `.instar/apprenticeship/matrix-acceptance.json`; BOUND acceptance artifacts
 * are appended tamper-evidently to logs/apprenticeship-decisions.jsonl (the
 * gate machine's acceptance store — Decision 20).
 */

import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  appendTamperEvidentDecisionRow,
  readDecisionRows,
  rowIntegrityHash,
  type AcceptanceChecker,
} from './ApprenticeshipStallGate.js';
import { parseRatificationConfirmation } from './ScopeAccretionRatifier.js';

export type AcceptanceScope = 'whole-set' | 'rows' | 'override' | 'degraded';

export interface AcceptancePrincipal {
  kind: 'operator-pin' | 'verified-operator' | 'bearer';
  /** Non-secret identifier (e.g. 'dashboard-pin', sha256 of the verified uid). */
  id: string;
}

export interface MatrixAcceptanceChallenge {
  challengeId: string;
  instanceId: string;
  framework: string;
  scope: AcceptanceScope;
  /** The bound content per Decision 20's granularity rule, fixed at mint. */
  contentHash: string;
  rowIds: string[];
  /** Override-scope only: the named rule the override excuses. */
  rule?: string;
  createdAt: string;
  used: boolean;
  /** Conversational arm: where the server-authored enumeration was posted. */
  topicId?: number;
  messageId?: number;
}

interface ChallengeStore {
  version: 1;
  challenges: MatrixAcceptanceChallenge[];
}

const CHALLENGE_CAP = 100;
const ACCEPTANCE_GATE = 'matrix-acceptance';

export interface MatrixAcceptanceStoreDeps {
  stateDir: string;
  decisionLogPath?: string;
  now?: () => Date;
  log?: (msg: string) => void;
}

export class MatrixAcceptanceStore implements AcceptanceChecker {
  private readonly storePath: string;
  private readonly decisionLogPath: string;
  private readonly now: () => Date;
  private readonly log?: (msg: string) => void;

  constructor(deps: MatrixAcceptanceStoreDeps) {
    this.storePath = path.join(deps.stateDir, 'apprenticeship', 'matrix-acceptance.json');
    this.decisionLogPath =
      deps.decisionLogPath ?? path.join(deps.stateDir, 'logs', 'apprenticeship-decisions.jsonl');
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log;
  }

  // ── Challenge persistence ──

  private loadStore(): ChallengeStore {
    try {
      const raw = JSON.parse(fs.readFileSync(this.storePath, 'utf8')) as ChallengeStore;
      if (raw && raw.version === 1 && Array.isArray(raw.challenges)) return raw;
    } catch {
      // fresh/corrupt store starts empty — challenges are short-lived mint
      // records, never the acceptance artifacts themselves.
    }
    return { version: 1, challenges: [] };
  }

  private saveStore(store: ChallengeStore): void {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const tmp = `${this.storePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
    fs.renameSync(tmp, this.storePath);
  }

  // ── Mint (server-enumerates) ──

  mintChallenge(input: {
    instanceId: string;
    framework: string;
    scope: AcceptanceScope;
    contentHash: string;
    rowIds: string[];
    rule?: string;
  }): MatrixAcceptanceChallenge {
    const challenge: MatrixAcceptanceChallenge = {
      challengeId: `MAC-${randomBytes(8).toString('hex')}`,
      instanceId: input.instanceId,
      framework: input.framework,
      scope: input.scope,
      contentHash: input.contentHash,
      rowIds: [...input.rowIds],
      ...(input.rule ? { rule: input.rule } : {}),
      createdAt: this.now().toISOString(),
      used: false,
    };
    const store = this.loadStore();
    store.challenges.push(challenge);
    if (store.challenges.length > CHALLENGE_CAP) {
      store.challenges = store.challenges.slice(-CHALLENGE_CAP);
    }
    this.saveStore(store);
    return challenge;
  }

  getChallenge(challengeId: string): MatrixAcceptanceChallenge | null {
    return this.loadStore().challenges.find((c) => c.challengeId === challengeId) ?? null;
  }

  /** Record where the conversational enumeration message landed (reply anchor). */
  attachMessage(challengeId: string, ref: { topicId: number; messageId: number }): void {
    const store = this.loadStore();
    const c = store.challenges.find((c) => c.challengeId === challengeId);
    if (!c) return;
    c.topicId = ref.topicId;
    c.messageId = ref.messageId;
    this.saveStore(store);
  }

  // ── Bind (operator-replies; single-use; hash re-checked at bind time) ──

  bind(input: {
    challengeId: string;
    principal: AcceptancePrincipal;
    /** The CURRENT content hash for the challenge's scope, recomputed by the
     *  caller at bind time — accept-then-edit voids the challenge (§2.2). */
    currentContentHash: string | null;
  }): { ok: boolean; reason: string; artifact?: Record<string, unknown> } {
    // Requester ≠ acceptor, structurally (Decision 14): the transition caller
    // holds the Bearer token, so a bearer-principal "acceptance" is
    // self-approval and is refused at this single chokepoint.
    if (input.principal.kind !== 'operator-pin' && input.principal.kind !== 'verified-operator') {
      return { ok: false, reason: 'acceptance principal must be operator-pin or verified-operator (requester ≠ acceptor)' };
    }
    const store = this.loadStore();
    const challenge = store.challenges.find((c) => c.challengeId === input.challengeId);
    if (!challenge) return { ok: false, reason: 'unknown challenge' };
    if (challenge.used) return { ok: false, reason: 'challenge already used (single-use — replay refused)' };
    if (input.currentContentHash === null || input.currentContentHash !== challenge.contentHash) {
      return { ok: false, reason: 'content hash mismatch — the enumerated content changed since the challenge was minted (accept-then-edit voids it)' };
    }
    challenge.used = true;
    this.saveStore(store);

    const artifact: Record<string, unknown> = {
      ts: this.now().toISOString(),
      gate: ACCEPTANCE_GATE,
      instanceId: challenge.instanceId,
      framework: challenge.framework,
      scope: challenge.scope,
      contentHash: challenge.contentHash,
      rowIds: challenge.rowIds,
      ...(challenge.rule ? { rule: challenge.rule } : {}),
      principal: { kind: input.principal.kind, id: input.principal.id },
      challengeRef: challenge.challengeId,
    };
    appendTamperEvidentDecisionRow(this.decisionLogPath, artifact);
    return { ok: true, reason: 'acceptance recorded', artifact };
  }

  // ── Read side (the gate's AcceptanceChecker surface) ──

  /** All integrity-valid acceptance artifacts (invalid-integrity rows are
   *  tamper-EVIDENT: skipped, never honored). */
  listAcceptances(): Array<Record<string, unknown>> {
    return readDecisionRows(this.decisionLogPath).filter((r) => {
      if (r.gate !== ACCEPTANCE_GATE) return false;
      return typeof r.integrity === 'string' && r.integrity === rowIntegrityHash(r);
    });
  }

  private principalAuthorized(r: Record<string, unknown>): boolean {
    const p = r.principal as { kind?: unknown } | undefined;
    return !!p && (p.kind === 'operator-pin' || p.kind === 'verified-operator');
  }

  hasWholeSetAcceptance(instanceId: string, contentHash: string): boolean {
    return this.listAcceptances().some(
      (r) =>
        (r.scope === 'whole-set' || r.scope === 'degraded') &&
        r.instanceId === instanceId &&
        r.contentHash === contentHash &&
        this.principalAuthorized(r),
    );
  }

  rowAcceptanceValid(ref: string, rowId: string, resolveRowSetHash: (rowIds: string[]) => string | null): boolean {
    return this.listAcceptances().some((r) => {
      if (r.challengeRef !== ref || r.scope !== 'rows') return false;
      if (!Array.isArray(r.rowIds) || !(r.rowIds as unknown[]).includes(rowId)) return false;
      if (!this.principalAuthorized(r)) return false;
      // Re-derive the joint hash over exactly the ACCEPTED rowIds from the
      // CURRENT matrix (Decision 20): unrelated codemod additions leave it
      // unchanged; any change to an accepted row — or its removal — voids.
      const current = resolveRowSetHash((r.rowIds as string[]).filter((x): x is string => typeof x === 'string'));
      return current !== null && current === r.contentHash;
    });
  }

  overrideExcuses(instanceId: string, rule: string, rowId: string, rowHash: string): boolean {
    return this.listAcceptances().some(
      (r) =>
        r.scope === 'override' &&
        r.instanceId === instanceId &&
        r.rule === rule &&
        Array.isArray(r.rowIds) &&
        (r.rowIds as unknown[]).includes(rowId) &&
        r.contentHash === rowHash &&
        this.principalAuthorized(r),
    );
  }

  // ── Conversational arm (mirrors ScopeAccretionRatifier's reply-anchor) ──

  /**
   * Observe one inbound topic message from the LIVE receive path. When the
   * VERIFIED operator reply-anchors an affirmative onto a recorded
   * enumeration message, the corresponding challenge binds — with the current
   * content hash re-resolved so accept-then-edit still voids it. Signal-only:
   * never blocks the receive path; errors are swallowed after logging.
   */
  async observeInbound(
    evt: { topicId: number; text: string; senderUid: string; messageId: number; replyToMessageId?: number },
    deps: {
      getOperatorUid: (topicId: number) => string | null;
      resolveCurrentContentHash: (challenge: MatrixAcceptanceChallenge) => string | null;
      ack?: (topicId: number, text: string) => Promise<unknown>;
    },
  ): Promise<void> {
    try {
      if (typeof evt.replyToMessageId !== 'number') return;
      const candidates = this.loadStore().challenges.filter(
        (c) => !c.used && c.topicId === evt.topicId && typeof c.messageId === 'number',
      );
      if (candidates.length === 0) return;
      // Know Your Principal: only the VERIFIED operator of this topic binds.
      const operatorUid = deps.getOperatorUid(evt.topicId);
      if (!operatorUid || operatorUid !== String(evt.senderUid)) return;
      const match = parseRatificationConfirmation(
        { text: evt.text, replyToMessageId: evt.replyToMessageId },
        candidates.map((c) => ({ setHash: c.challengeId, messageId: c.messageId! })),
      );
      if (!match.boundSetHash || !match.replyAnchored) return;
      const challenge = candidates.find((c) => c.challengeId === match.boundSetHash);
      if (!challenge) return;
      const bound = this.bind({
        challengeId: challenge.challengeId,
        principal: {
          kind: 'verified-operator',
          id: createHash('sha256').update(String(evt.senderUid)).digest('hex'),
        },
        currentContentHash: deps.resolveCurrentContentHash(challenge),
      });
      if (bound.ok) {
        await deps.ack?.(
          evt.topicId,
          `Stall-coverage matrix acceptance recorded for instance '${challenge.instanceId}' (${challenge.scope}, ${challenge.rowIds.length} row id(s)).`,
        );
      }
    } catch (err) {
      this.log?.(`[matrix-acceptance] observe error (ignored): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Enumeration rendering (server-authored — the operator approves EXACTLY this) ──

  renderEnumeration(challenge: MatrixAcceptanceChallenge): string {
    const lines = [
      `Accept the stall-coverage matrix ${challenge.scope === 'degraded' ? 'DEGRADED verdict (matrix-unverifiable-no-source)' : `enumeration (${challenge.scope})`} for instance '${challenge.instanceId}' (framework ${challenge.framework})?`,
      ...challenge.rowIds.slice(0, 50).map((id) => `- ${id}`),
      ...(challenge.rowIds.length > 50 ? [`…and ${challenge.rowIds.length - 50} more`] : []),
      ...(challenge.rule ? [`Override rule: ${challenge.rule}`] : []),
      '',
      `Content hash: ${challenge.contentHash.slice(0, 16)}… — challenge ${challenge.challengeId} (single-use).`,
      'Reply to THIS message with yes/approve, or bind via the dashboard-PIN acceptance route.',
    ];
    return lines.join('\n');
  }
}
