/**
 * PermissionPromptAutoResolver — the always-on, unconditional SAFETY FLOOR that
 * keeps Instar from being silently wedged on an agent-framework approval prompt.
 *
 * Spec: docs/specs/framework-permission-prompt-robustness.md
 * Convergence: docs/specs/reports/framework-permission-prompt-robustness-convergence.md
 *
 * The bug it closes (Claude Code 2.1.176–177): a hardcoded Bash safety classifier
 * pauses a session on a terminal Y/N approval prompt (e.g. "Compound command
 * contains cd with output redirection — manual approval required … Do you want to
 * proceed? ❯ 1. Yes / 2. No"). It runs BEFORE all permission rules and hooks, so
 * `--dangerously-skip-permissions` cannot pre-answer it. A remote agent (Telegram /
 * dashboard) cannot press a terminal key, so the session freezes forever while still
 * LOOKING busy — a third liveness state every existing watcher mis-reads.
 *
 * The operator directive that governs the design: a low-level command/tool approval
 * prompt is NEVER a user decision — the agent runs operator-owned sessions with full
 * machine access. So a prompt-parked session is a DEFECT to auto-clear and detect,
 * never a "waiting for operator" state.
 *
 * TWO PURE DETECTORS + a stateful driver:
 *   - Layer 2 (`detectApprovalPrompt`, LOAD-BEARING): matches a registered approval
 *     signature with the ❯ selector cursor sitting on an approve option, at the
 *     genuine bottom of a non-generating pane → the driver sends `Enter` (confirm the
 *     highlighted default). Bar-raising MITIGATION, not closure — a text capture
 *     cannot perfectly tell TUI chrome from displayed content, so the residual is
 *     bounded by Enter-only + re-capture-before-send + a per-episode attempt cap + a
 *     terminal defect.
 *   - Layer 3 (`detectPersistingMenu`, prose-AGNOSTIC observability): matches ANY
 *     persisting glyph-led numbered menu the resolver did NOT auto-clear (❯-not-on-
 *     approve, prose-drift, an open non-approval picker) → after a persistence
 *     threshold it raises the SAME terminal defect. This is what makes "never
 *     silently stranded" TRUE for the cases Layer 2 declines, and doubles as the
 *     prompt-string drift detector.
 *
 * Signal-vs-authority: the detectors are pure. The ONLY actuation is `sendKey(…,
 * 'Enter')` (a benign empty submit on a false match) and `raiseDefect` (an Attention
 * item). No new blocking authority. All I/O is injected (DI), so the detectors +
 * state machine are fully unit-testable.
 *
 * Privacy: the audit logs only the STATIC registry pattern NAMES and a one-way
 * fingerprint — never the raw tail. Layer 3's dedup key is a one-way digest of the
 * option labels — the labels themselves are never logged.
 */

import { createHash } from 'node:crypto';
import { leadGlyphsOf, stripLineLead } from '../core/paneTail.js';

// ─── Constants (exported per spec — the bounded-state + anti-hammer dials) ───────

/** Per-episode consecutive un-cleared sends before Layer 2 declares Terminal. */
export const MAX_ATTEMPTS = 3;
/** Layer-3 consecutive matched ticks before the persisting-menu Terminal defect. */
export const LAYER3_PERSIST_TICKS = 4;
/** Per-entry staleness TTL — neither state map can grow with uptime (Bounded Accumulation). */
export const STATE_TTL_MS = 30 * 60 * 1000;

/** How many trailing non-empty lines count as "the genuine bottom" of the menu. */
const MENU_BOTTOM_WINDOW = 6;

/** The U+276F selector cursor glyph (❯) Claude Code paints on the focused option. */
const SELECTOR_GLYPH = '❯';

// ─── Pane-tail line model ────────────────────────────────────────────────────────

/**
 * One non-empty line of a captured tail, split into the lead-STRIPPED content
 * (`text`, via `stripLineLead`) and the separated leading run (`leadGlyphs`, via
 * `leadGlyphsOf`). `text` lets anchored regexes match the real first token; the
 * separated `leadGlyphs` lets the detector test for the ❯ selector cursor
 * specifically (not merely "some glyph", which `wasGlyphLed` answers).
 */
export interface PaneTailLine {
  text: string;
  leadGlyphs: string;
}

/**
 * Split a raw tmux tail capture into `PaneTailLine`s — dropping whitespace-only
 * lines (like `liveTail`), mapping each remaining RAW line → its lead-stripped
 * `text` + its `leadGlyphs`. Pure.
 */
export function toPaneTailLines(rawTail: string): PaneTailLine[] {
  if (!rawTail) return [];
  const out: PaneTailLine[] = [];
  for (const line of rawTail.split('\n')) {
    if (!line.trim()) continue; // drop empties like liveTail
    out.push({ text: stripLineLead(line), leadGlyphs: leadGlyphsOf(line) });
  }
  return out;
}

// ─── Framework registry (framework-EXTENSIBLE; only claude-code is verified) ─────

/** A single registered prose pattern carrying its stable symbolic name. */
export interface ProsePattern {
  name: string;
  pattern: RegExp;
}

/** The registered signature for one framework. */
export interface ApprovalSignature {
  prosePatterns: ProsePattern[];
  /** Anchored at the start of the post-`N.` option label — an APPROVE verb. */
  approveLabels: RegExp;
}

/**
 * Approval-prompt signatures, keyed by framework. Only `claude-code` is VERIFIED at
 * ship; codex/gemini entries are deliberately OMITTED — off until a live prompt is
 * characterized (Decision 10). The resolver tries EVERY registered signature each
 * tick (it does not depend on a session's framework field, undefined on legacy
 * records); a Claude prompt won't match a Codex pattern, so trying all is safe.
 *
 * `matchedPatternNames` (what the audit + fingerprint use) are these STATIC `name`s —
 * never matched tail text — so neither artifact can ever carry pane-derived bytes.
 */
export const APPROVAL_PROMPT_SIGNATURES: Record<string, ApprovalSignature> = {
  'claude-code': {
    prosePatterns: [
      { name: 'manual-approval', pattern: /manual approval required/i },
      { name: 'path-resolution-bypass', pattern: /path resolution bypass/i },
      {
        name: 'compound-cd-redirect',
        pattern: /Compound command contains cd with output redirection/i,
      },
      { name: 'do-you-want-to-proceed', pattern: /Do you want to proceed\?/i },
    ],
    approveLabels: /^(yes|proceed|allow|continue)\b/i,
  },
  // 'codex-cli':  { prosePatterns: [ /* off until a live prompt is characterized */ ], approveLabels: /…/ },
  // 'gemini-cli': { prosePatterns: [ /* off until a live prompt is characterized */ ], approveLabels: /…/ },
};

// ─── Detector outputs ────────────────────────────────────────────────────────────

/** A Layer-2 match — an answerable, focused approval menu. */
export interface ApprovalMatch {
  framework: string;
  /** The STATIC registry names that matched, sorted. Never tail text. */
  matchedPatternNames: string[];
  /** The only key the resolver ever sends. */
  approveKey: 'Enter';
  /** hash(framework + sorted matchedPatternNames) — invariant across redraws,
   *  carries NO tail-derived bytes. */
  stableFingerprint: string;
}

/** A Layer-3 match — a persisting glyph-led menu the resolver will NOT auto-answer. */
export interface MenuMatch {
  /** The sorted texts of the numbered option lines (consumed ONLY as hash input). */
  optionLabels: string[];
}

// ─── Pure structural helpers ─────────────────────────────────────────────────────

const NUMBERED_OPTION_RE = /^\s*\d+\.\s/;
const OPTION_PREFIX_RE = /^\s*\d+\.\s*/;
const AFFORDANCE_ESC_RE = /Esc to cancel/i;
const AFFORDANCE_PROCEED_RE = /Do you want to proceed/i;
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** True iff the leadGlyphs run contains the ❯ selector cursor specifically. */
function hasSelectorGlyph(leadGlyphs: string): boolean {
  return leadGlyphs.includes(SELECTOR_GLYPH);
}

/**
 * True iff the leadGlyphs run contains ANY TUI lead glyph. `leadGlyphs` is the
 * `LEAD_RE` run (ANSI-SGR | whitespace | lead-glyph); strip the ANSI + whitespace
 * and anything remaining must be a lead glyph. (Avoids depending on paneTail's
 * private glyph class.)
 */
function hasAnyLeadGlyph(leadGlyphs: string): boolean {
  return leadGlyphs.replace(ANSI_SGR_RE, '').replace(/\s+/g, '').length > 0;
}

/** A line that is part of a menu's bottom structure (option line OR affordance). */
function isMenuStructureLine(l: PaneTailLine): boolean {
  return (
    NUMBERED_OPTION_RE.test(l.text) ||
    AFFORDANCE_ESC_RE.test(l.text) ||
    AFFORDANCE_PROCEED_RE.test(l.text)
  );
}

function joinedText(tail: PaneTailLine[]): string {
  return tail.map((l) => l.text).join('\n');
}

/**
 * "Genuine bottom" gate shared by both detectors: the LAST non-empty line is itself
 * a menu-structure line (so there is no live idle input box rendered BELOW the menu),
 * and the triggering option line sits within the last `MENU_BOTTOM_WINDOW` lines.
 */
function lastLineIsMenuStructure(tail: PaneTailLine[]): boolean {
  const last = tail[tail.length - 1];
  return !!last && isMenuStructureLine(last);
}

function withinBottomWindow(tail: PaneTailLine[], index: number): boolean {
  return index >= tail.length - MENU_BOTTOM_WINDOW;
}

// ─── Layer 2 — load-bearing approval detector ────────────────────────────────────

/**
 * Pure Layer-2 detector. Returns a match ONLY when ALL hold:
 *   1. ≥2 DISTINCT named prose patterns from the framework's registry matched;
 *   2. a line whose `leadGlyphs` contains ❯ AND whose `text` is `N.` followed by an
 *      approve label (the selector cursor is ON an approve option);
 *   3. the menu is at the genuine bottom (no idle input box below, option line within
 *      the bottom window) AND the session is not generating.
 *
 * Honest residual (spec security#1): a tmux text capture cannot perfectly prove a
 * `❯ 1. Yes` is TUI chrome vs displayed content. Requirements 1–3 substantially raise
 * the bar; the residual is bounded by the Enter-only keystroke + re-capture + attempt
 * cap + Terminal defect in the driver, never by this detector pretending closure.
 */
export function detectApprovalPrompt(
  tail: PaneTailLine[],
  framework: string,
  isGenerating: boolean,
): ApprovalMatch | null {
  if (isGenerating) return null;
  if (!tail.length) return null;
  const sig = APPROVAL_PROMPT_SIGNATURES[framework];
  if (!sig) return null;

  // (1) ≥2 DISTINCT named prose patterns.
  const joined = joinedText(tail);
  const matched = new Set<string>();
  for (const p of sig.prosePatterns) {
    if (p.pattern.test(joined)) matched.add(p.name);
  }
  if (matched.size < 2) return null;

  // (2) ❯ selector cursor on an approve option.
  let approveIndex = -1;
  for (let i = 0; i < tail.length; i++) {
    const l = tail[i];
    if (!hasSelectorGlyph(l.leadGlyphs)) continue;
    const m = OPTION_PREFIX_RE.exec(l.text);
    if (!m) continue;
    const rest = l.text.slice(m[0].length);
    if (sig.approveLabels.test(rest)) {
      approveIndex = i;
      break;
    }
  }
  if (approveIndex < 0) return null;

  // (3) genuine bottom + not generating (generating handled at the top).
  if (!withinBottomWindow(tail, approveIndex)) return null;
  if (!lastLineIsMenuStructure(tail)) return null;

  const matchedPatternNames = [...matched].sort();
  const stableFingerprint = sha256(framework + '|' + matchedPatternNames.join(','));
  return { framework, matchedPatternNames, approveKey: 'Enter', stableFingerprint };
}

// ─── Layer 3 — prose-AGNOSTIC persisting-menu detector ───────────────────────────

/**
 * Pure Layer-3 detector. Prose-agnostic by design (so it catches drift): matches
 * purely on STRUCTURE — (i) a glyph-led numbered option line, (ii) a generic
 * blocking affordance (`Esc to cancel` / `Do you want to proceed` / ≥2 numbered
 * options), (iii) genuine bottom, (iv) not generating. Deliberately matches the
 * cases Layer 2 declines (❯ not on an approve option, prose-drift) AS WELL AS a
 * genuinely open non-approval picker (an accepted, benign surface — something IS
 * waiting for input the agent cannot self-answer, worth one notice).
 */
export function detectPersistingMenu(
  tail: PaneTailLine[],
  isGenerating: boolean,
): MenuMatch | null {
  if (isGenerating) return null;
  if (!tail.length) return null;

  // The full option set (for the structure key) + the glyph-led subset (the trigger).
  const numberedLines: PaneTailLine[] = [];
  let glyphLedNumberedInWindow = false;
  for (let i = 0; i < tail.length; i++) {
    const l = tail[i];
    if (!NUMBERED_OPTION_RE.test(l.text)) continue;
    numberedLines.push(l);
    if (hasAnyLeadGlyph(l.leadGlyphs) && withinBottomWindow(tail, i)) {
      glyphLedNumberedInWindow = true;
    }
  }
  // (i) at least one glyph-led numbered option line near the bottom.
  if (!glyphLedNumberedInWindow) return null;

  // (ii) a generic blocking affordance.
  const joined = joinedText(tail);
  const hasAffordance =
    AFFORDANCE_ESC_RE.test(joined) ||
    AFFORDANCE_PROCEED_RE.test(joined) ||
    numberedLines.length >= 2;
  if (!hasAffordance) return null;

  // (iii) genuine bottom.
  if (!lastLineIsMenuStructure(tail)) return null;

  const optionLabels = numberedLines.map((l) => l.text).sort();
  return { optionLabels };
}

// ─── Driver DI surface ───────────────────────────────────────────────────────────

/** A Terminal defect raised to the Attention surface (the wiring owns dedup). */
export interface ResolverDefect {
  sessionName: string;
  layer: 'layer2' | 'layer3';
  /** sessionName + fingerprint (Layer 2) OR sessionName + menuStructureKey (Layer 3). */
  dedupKey: string;
  fingerprint?: string;
  menuStructureKey?: string;
  /** STATIC names only (Layer 2). */
  matchedPatternNames?: string[];
  reason: string;
}

/** The outcome of one Layer-2 action, recorded in the audit. */
export type ResolverOutcome =
  | 'answered'
  | 'retried'
  | 'cleared'
  | 'persisted-terminal'
  | 'send-failed'
  | 'race-aborted';

/** One audit row. NEVER carries raw tail — only the static matched-pattern names. */
export interface ResolverAuditRow {
  ts: number;
  sessionName: string;
  framework: string;
  matchedPatternNames: string[];
  keySent: 'Enter' | null;
  fingerprint: string;
  attempt: number;
  outcome: ResolverOutcome;
}

export interface PermissionPromptResolverDeps {
  /** Send a keystroke to the session's pane. Returns/resolves false on failure. */
  sendKey: (session: string, key: string) => boolean | Promise<boolean>;
  /** Re-capture the live tail for the race-guard. Null/throw → race-aborted. */
  reCaptureTail: (session: string) => Promise<PaneTailLine[] | null>;
  /** Is the session generating right now? (e.g. looksGeneratingNow on the tail.) */
  isGenerating: (rawOrTail: string) => boolean;
  /** Raise the Terminal Attention defect (the wiring dedups + age-escalates). */
  raiseDefect: (args: ResolverDefect) => void;
  /** Append one audit row (size-bounded JSONL in the wiring). Must not throw up. */
  appendAudit: (row: ResolverAuditRow) => void;
  /** Clock (tests). */
  now: () => number;
  /** The emergency off-switch (absent ⇒ false ⇒ floor ON). */
  emergencyDisabled: () => boolean;
}

// ─── Per-entry state ─────────────────────────────────────────────────────────────

interface Layer2Entry {
  session: string;
  fingerprint: string;
  framework: string;
  matchedPatternNames: string[];
  consecutiveUnclearedSends: number;
  createdAt: number;
  lastTick: number;
  terminalRaised: boolean;
}

interface Layer3Entry {
  session: string;
  menuStructureKey: string;
  persistTicks: number;
  createdAt: number;
  lastTick: number;
  terminalRaised: boolean;
}

const KEY_SEP = ' ';

// ─── The driver ──────────────────────────────────────────────────────────────────

export class PermissionPromptAutoResolver {
  /** Layer-2 episode state, keyed (session, stableFingerprint). */
  private readonly episodes = new Map<string, Layer2Entry>();
  /** Layer-3 persistence state, keyed (session, menuStructureKey). */
  private readonly persistMenus = new Map<string, Layer3Entry>();
  /** Last evaluate/sweep wall-clock — the GuardRegistry liveness read. */
  private lastTickAt = 0;

  constructor(private readonly deps: PermissionPromptResolverDeps) {}

  /**
   * Per-candidate tick logic for one running session. Captures nothing of its own —
   * the caller passes the already-in-hand fuller tail. Layer 2 owns a tick it
   * matched (returns before Layer 3), so the two can never double-raise one wedge.
   */
  async evaluate(session: string, fullTail: PaneTailLine[]): Promise<void> {
    this.lastTickAt = this.deps.now();
    if (this.deps.emergencyDisabled()) return;
    const now = this.deps.now();
    const generating = this.deps.isGenerating(joinedText(fullTail));

    // Layer 2 — try every registered framework signature.
    let approval: ApprovalMatch | null = null;
    for (const fw of Object.keys(APPROVAL_PROMPT_SIGNATURES)) {
      const m = detectApprovalPrompt(fullTail, fw, generating);
      if (m) {
        approval = m;
        break;
      }
    }

    if (approval) {
      const keepL2 = this.l2Key(session, approval.stableFingerprint);
      this.reconcileSession(session, keepL2, null, now);
      await this.handleLayer2(session, approval, now);
      return; // Layer 2 owns this tick.
    }

    // Layer 3 — prose-agnostic persisting-menu detection.
    const menu = detectPersistingMenu(fullTail, generating);
    if (menu) {
      const mk = this.menuStructureKey(session, menu.optionLabels);
      const keepL3 = this.l3Key(session, mk);
      this.reconcileSession(session, null, keepL3, now);
      this.handleLayer3(session, mk, now);
      return;
    }

    // Nothing matched → every prompt for this session cleared.
    this.reconcileSession(session, null, null, now);
  }

  /**
   * Evict every state entry for `session` EXCEPT the one active this tick (the
   * reset-on-clear rule). An evicted Layer-2 entry that had un-cleared sends and was
   * not already terminal audits `cleared` (the episode's prompt was answered/gone).
   */
  private reconcileSession(
    session: string,
    keepL2Key: string | null,
    keepL3Key: string | null,
    now: number,
  ): void {
    const sessionPrefix = session + KEY_SEP;
    for (const [k, st] of this.episodes) {
      if (!k.startsWith(sessionPrefix)) continue;
      if (k === keepL2Key) continue;
      if (st.consecutiveUnclearedSends > 0 && !st.terminalRaised) {
        this.audit(
          now,
          st.session,
          st.framework,
          st.matchedPatternNames,
          null,
          st.fingerprint,
          st.consecutiveUnclearedSends,
          'cleared',
        );
      }
      this.episodes.delete(k);
    }
    for (const [k, st] of this.persistMenus) {
      if (!k.startsWith(sessionPrefix)) continue;
      if (k === keepL3Key) continue;
      this.persistMenus.delete(k);
    }
  }

  private async handleLayer2(session: string, approval: ApprovalMatch, now: number): Promise<void> {
    const key = this.l2Key(session, approval.stableFingerprint);
    let st = this.episodes.get(key);
    if (!st) {
      st = {
        session,
        fingerprint: approval.stableFingerprint,
        framework: approval.framework,
        matchedPatternNames: approval.matchedPatternNames,
        consecutiveUnclearedSends: 0,
        createdAt: now,
        lastTick: now,
        terminalRaised: false,
      };
      this.episodes.set(key, st);
    }
    st.lastTick = now;

    // Already surfaced as un-clearable → stop sending this episode.
    if (st.terminalRaised) return;

    // MAX_ATTEMPTS consecutive un-cleared sends and the menu is STILL present → Terminal.
    if (st.consecutiveUnclearedSends >= MAX_ATTEMPTS) {
      st.terminalRaised = true;
      this.deps.raiseDefect({
        sessionName: session,
        layer: 'layer2',
        dedupKey: session + '|' + approval.stableFingerprint,
        fingerprint: approval.stableFingerprint,
        matchedPatternNames: approval.matchedPatternNames,
        reason:
          'a session is wedged on an approval prompt I could not auto-clear (the host may have changed its prompt UI) — it needs a look',
      });
      this.audit(
        now,
        session,
        approval.framework,
        approval.matchedPatternNames,
        null,
        approval.stableFingerprint,
        st.consecutiveUnclearedSends,
        'persisted-terminal',
      );
      return;
    }

    // Re-capture-before-send (closes the capture→send race). Only send if the SAME
    // fingerprint is still the live focused menu.
    let recap: PaneTailLine[] | null = null;
    try {
      recap = await this.deps.reCaptureTail(session);
    } catch {
      recap = null;
    }
    if (!recap) {
      this.audit(
        now,
        session,
        approval.framework,
        approval.matchedPatternNames,
        null,
        approval.stableFingerprint,
        st.consecutiveUnclearedSends,
        'race-aborted',
      );
      return;
    }
    const reGen = this.deps.isGenerating(joinedText(recap));
    const reMatch = detectApprovalPrompt(recap, approval.framework, reGen);
    if (!reMatch || reMatch.stableFingerprint !== approval.stableFingerprint) {
      this.audit(
        now,
        session,
        approval.framework,
        approval.matchedPatternNames,
        null,
        approval.stableFingerprint,
        st.consecutiveUnclearedSends,
        'race-aborted',
      );
      return;
    }

    // Send the (only) approve key.
    let ok = false;
    try {
      ok = await Promise.resolve(this.deps.sendKey(session, 'Enter'));
    } catch {
      ok = false;
    }
    if (!ok) {
      this.audit(
        now,
        session,
        approval.framework,
        approval.matchedPatternNames,
        'Enter',
        approval.stableFingerprint,
        st.consecutiveUnclearedSends,
        'send-failed',
      );
      return;
    }
    st.consecutiveUnclearedSends += 1;
    const outcome: ResolverOutcome = st.consecutiveUnclearedSends === 1 ? 'answered' : 'retried';
    this.audit(
      now,
      session,
      approval.framework,
      approval.matchedPatternNames,
      'Enter',
      approval.stableFingerprint,
      st.consecutiveUnclearedSends,
      outcome,
    );
  }

  private handleLayer3(session: string, menuStructureKey: string, now: number): void {
    const key = this.l3Key(session, menuStructureKey);
    let st = this.persistMenus.get(key);
    if (!st) {
      st = {
        session,
        menuStructureKey,
        persistTicks: 0,
        createdAt: now,
        lastTick: now,
        terminalRaised: false,
      };
      this.persistMenus.set(key, st);
    }
    st.lastTick = now;
    if (st.terminalRaised) return;
    st.persistTicks += 1;
    if (st.persistTicks >= LAYER3_PERSIST_TICKS) {
      st.terminalRaised = true;
      this.deps.raiseDefect({
        sessionName: session,
        layer: 'layer3',
        dedupKey: session + '|' + menuStructureKey,
        menuStructureKey,
        reason:
          'a session is wedged on a menu I could not auto-clear (an unrecognized or drifted prompt) — it needs a look',
      });
    }
  }

  /**
   * Evict BOTH maps' entries for sessions no longer running, and any entry older
   * than the per-entry TTL (stale lastTick). Neither map can grow with uptime.
   * Called each tick.
   */
  sweep(runningSessions: Set<string>): void {
    const now = this.deps.now();
    this.lastTickAt = now;
    for (const [k, st] of this.episodes) {
      if (!runningSessions.has(st.session) || now - st.lastTick > STATE_TTL_MS) {
        this.episodes.delete(k);
      }
    }
    for (const [k, st] of this.persistMenus) {
      if (!runningSessions.has(st.session) || now - st.lastTick > STATE_TTL_MS) {
        this.persistMenus.delete(k);
      }
    }
  }

  /** Cheap, no-I/O runtime liveness read for the GuardRegistry (GET /guards). */
  guardStatus(): { enabled: boolean; lastTickAt: number } {
    return { enabled: !this.deps.emergencyDisabled(), lastTickAt: this.lastTickAt };
  }

  /** Current live state-map sizes (both are provably bounded by the eviction triple). */
  stateSizes(): { episodes: number; persistMenus: number } {
    return { episodes: this.episodes.size, persistMenus: this.persistMenus.size };
  }

  // ─── internals ─────────────────────────────────────────────────────────────────

  private l2Key(session: string, fingerprint: string): string {
    return session + KEY_SEP + fingerprint;
  }

  private l3Key(session: string, menuStructureKey: string): string {
    return session + KEY_SEP + menuStructureKey;
  }

  private menuStructureKey(session: string, optionLabels: string[]): string {
    return sha256(session + '|' + optionLabels.join(','));
  }

  private audit(
    ts: number,
    sessionName: string,
    framework: string,
    matchedPatternNames: string[],
    keySent: 'Enter' | null,
    fingerprint: string,
    attempt: number,
    outcome: ResolverOutcome,
  ): void {
    try {
      this.deps.appendAudit({
        ts,
        sessionName,
        framework,
        matchedPatternNames,
        keySent,
        fingerprint,
        attempt,
        outcome,
      });
    } catch {
      // Observability must never throw into the monitor loop.
    }
  }
}
