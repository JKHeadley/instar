/**
 * geminiPaygGoLive — the go-live of the Gemini pay-per-use lane
 * (docs/specs/gemini-payg-metered-lane.md §4 "The production key is minted at go-live",
 * §8 "Go-live: one PIN entry, by a new pre-gate action").
 *
 * What lives here, and what does not:
 *   - the SETUP STRUCT the operator approves, its canonical hash, and the plan text
 *     generated from it one line per field (the operator approves the server's words);
 *   - the machine-local files: the proposed setup, the pending-setup INTENT the PIN
 *     commit writes, the key-handoff attestation, and the server-recorded mint start;
 *   - the render-time preconditions, each a NAMED blocker (never a pass by absence);
 *   - the pending-intent APPLY, run at boot (or hot when money is already enforcing):
 *     one durable caps-store write, idempotent by intent hash, checked against the
 *     commit's audit row. A failed apply freezes the door and raises one notice; it
 *     never throws, so a bad intent can never crash-loop the server.
 *
 * The commit itself (PIN, plan binding, restart safeguards) is the enable surface's
 * (`MoneyLayerEnableSurface`). Spending is the gate's. Nothing here moves money.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import type { RoutingSpendCapsStore, MeteredCallerId, MeteredDoorPolicy, CapsStoreFile } from './RoutingSpendCapsStore.js';
import { failoverThresholdAllowsArming, WORST_CASE_FENCE_MS } from './meteredLaneMesh.js';

export const GEMINI_PAYG_DOOR = 'gemini-api';
/** The vault name of the lane's key — a label here, never read here (the reader is geminiApiKeyReader). */
export const GEMINI_PAYG_KEY_REF_NAME = 'gemini_api_key_payg';
export const GEMINI_PAYG_SETUP_SCHEMA = 'gemini-payg-setup/1';
export const GEMINI_PAYG_RECONCILE_JOB = 'gemini-payg-reconcile';

/** The first-screen line, verbatim (§8). */
export const GEMINI_PAYG_FIRST_SCREEN_LINE =
  "Gemini joins as a reviewer and a second opinion. Choosing it as a conversation's engine is not in this version.";

/** The restart disclosure the existing restart route shows (§8), verbatim. */
export const GEMINI_PAYG_RESTART_DISCLOSURE = 'this restarts the whole agent server; sessions on this machine are interrupted';

/** The operator's figure, quoted with its source (topic 145625, 2026-11-20). */
export const GEMINI_PAYG_OPERATOR_FIGURE_USD = 50;
export const GEMINI_PAYG_OPERATOR_FIGURE_SOURCE =
  'Justin, 2026-11-20, topic 145625: "let\'s set a $50 cap for now" and "Yes, please create a separate $50 budget" (15:12 PST)';

/** Agent-proposed values (§5 table), each marked proposed and changeable in the plan. */
export const GEMINI_PAYG_PROPOSED_DEFAULTS = Object.freeze({
  monthlyCapUsd: 50,
  dailyCapUsd: 10,
  periodTimeZone: 'America/Los_Angeles',
  perCallCeilingUsd: 2.5,
  provisionalCeilingUsd: 10,
  e2MonthSharePct: 40,
  e2DayCapUsd: 4,
  e1PassesPerRound: 1,
});

export type GoogleSpendLimitKind = 'hard-cap' | 'budget-alert-only';

/** The setup struct — exactly what the PIN commit approves and the apply writes. */
export interface GeminiPaygSetup {
  schema: typeof GEMINI_PAYG_SETUP_SCHEMA;
  door: string;
  keyRef: string;
  provider: string;
  /** The MESH id of the one spending machine. Render runs only there. */
  designatedMachineId: string;
  designatedMachineName: string | null;
  designationEpoch: number;
  monthlyCapUsd: number;
  dailyCapUsd: number;
  periodTimeZone: string;
  perCallCeilingUsd: number;
  provisionalCeilingUsd: number;
  e2MonthSharePct: number;
  e2DayCapUsd: number;
  e1PassesPerRound: number;
  callers: MeteredCallerId[];
  e3Components: string[];
  /** E4 (doorway-scan liveness) — off in v1. */
  doorwayLivenessOn: false;
  models: string[];
  keyGeneration: string;
  providerKeyId: string;
  googleSpendLimitKind: GoogleSpendLimitKind;
  googleSpendLimitUsd: number;
  reconcileJobEnabled: boolean;
  /** A lane transfer block, or null for a first go-live (transfers are a later plan). */
  transfer: null;
}

// ── Canonical hash ───────────────────────────────────────────────────

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export function geminiPaygSetupHash(s: GeminiPaygSetup): string {
  return crypto.createHash('sha256').update(canonical(s)).digest('hex');
}

/** Store-independent validation of a setup struct (an intent or a proposal read from disk). */
export function validateGeminiPaygSetup(v: unknown): string | null {
  if (!v || typeof v !== 'object') return 'not an object';
  const s = v as GeminiPaygSetup;
  if (s.schema !== GEMINI_PAYG_SETUP_SCHEMA) return 'unknown schema';
  if (s.door !== GEMINI_PAYG_DOOR || s.keyRef !== GEMINI_PAYG_KEY_REF_NAME || s.provider !== 'google') return 'wrong door/key/provider';
  if (typeof s.designatedMachineId !== 'string' || !s.designatedMachineId.trim()) return 'designatedMachineId missing';
  if (!Number.isInteger(s.designationEpoch) || s.designationEpoch < 1) return 'designationEpoch must be a positive integer';
  const pos = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0;
  for (const f of ['monthlyCapUsd', 'dailyCapUsd', 'perCallCeilingUsd', 'provisionalCeilingUsd', 'e2DayCapUsd', 'googleSpendLimitUsd'] as const) {
    if (!pos(s[f])) return `${f} must be > 0`;
  }
  if (typeof s.e2MonthSharePct !== 'number' || !(s.e2MonthSharePct >= 0 && s.e2MonthSharePct <= 100)) return 'e2MonthSharePct must be in [0,100]';
  if (!Number.isInteger(s.e1PassesPerRound) || s.e1PassesPerRound < 0) return 'e1PassesPerRound must be a non-negative integer';
  if (s.dailyCapUsd > s.monthlyCapUsd) return 'the daily guard is above the monthly cap';
  if (!Array.isArray(s.callers) || s.callers.some((c) => c !== 'spec-review' && c !== 'second-opinion')) return 'v1 callers are spec-review and second-opinion only';
  if (!Array.isArray(s.e3Components) || s.e3Components.length !== 0) return 'v1 has no background-check (E3) components';
  if (s.doorwayLivenessOn !== false) return 'the model-checking tool (E4) is off in v1';
  if (!Array.isArray(s.models) || s.models.length === 0 || s.models.some((m) => typeof m !== 'string' || !m)) return 'models missing';
  if (typeof s.keyGeneration !== 'string' || !/^[0-9a-f]{64}$/.test(s.keyGeneration)) return 'keyGeneration must be a sha256 hex fingerprint';
  if (typeof s.providerKeyId !== 'string' || !s.providerKeyId.trim()) return 'providerKeyId missing';
  if (s.googleSpendLimitKind !== 'hard-cap' && s.googleSpendLimitKind !== 'budget-alert-only') return 'googleSpendLimitKind invalid';
  if (typeof s.periodTimeZone !== 'string' || !s.periodTimeZone) return 'periodTimeZone missing';
  if (typeof s.reconcileJobEnabled !== 'boolean') return 'reconcileJobEnabled must be boolean';
  if (s.transfer !== null) return 'lane transfers are not in this version';
  return null;
}

/** The door policy the apply writes from a setup (releaseState starts armed-pending-proof). */
export function doorPolicyFromSetup(s: GeminiPaygSetup): MeteredDoorPolicy {
  return {
    perCallCeilingUsd: s.perCallCeilingUsd,
    provisionalCeilingUsd: s.provisionalCeilingUsd,
    e2MonthSharePct: s.e2MonthSharePct,
    e2DayCapUsd: s.e2DayCapUsd,
    e1PassesPerRound: s.e1PassesPerRound,
    keyGeneration: s.keyGeneration,
    meteredCallers: { callers: [...s.callers], e3Components: [...s.e3Components] },
    throughputFloorTps: {},
    releaseState: 'armed-pending-proof',
    designationEpoch: s.designationEpoch,
  };
}

// ── Plan text ───────────────────────────────────────────────────────

const usd = (n: number) => `$${n.toFixed(2)}`;

export interface PlanTextContext {
  /** modelId → verified on Google's page (the manifest's `verified` flag). */
  modelVerified: (modelId: string) => boolean;
}

/**
 * The plan text, generated from the exact struct, one line per field (§8). The first
 * line is the first-screen line verbatim. A property test pins that every committed
 * field's value appears in the text.
 */
export function renderGeminiPaygPlanLines(s: GeminiPaygSetup, ctx: PlanTextContext): string[] {
  const where = s.designatedMachineName ? `${s.designatedMachineName} (${s.designatedMachineId})` : s.designatedMachineId;
  const e2MonthUsd = (s.monthlyCapUsd * s.e2MonthSharePct) / 100;
  const allVerified = s.models.every((m) => ctx.modelVerified(m));
  const lines: string[] = [
    GEMINI_PAYG_FIRST_SCREEN_LINE,
    `Turn the spending-control layer ON for machine ${where}, and set up the Gemini pay-per-use door (${s.door}) with its own key and its own limits.`,
    `Monthly cap: ${usd(s.monthlyCapUsd)} per month, counted on the ${s.periodTimeZone} calendar month (Google's billing month).`,
    s.monthlyCapUsd === GEMINI_PAYG_OPERATOR_FIGURE_USD
      ? `That is Justin's figure. Source: ${GEMINI_PAYG_OPERATOR_FIGURE_SOURCE} — a separate $50 for this lane in its own Google project.`
      : `Justin's figure was $50 (source: ${GEMINI_PAYG_OPERATOR_FIGURE_SOURCE}); this proposal differs from it.`,
    `Proposed by the agent, changeable before you approve: ${usd(s.dailyCapUsd)} per day (Pacific calendar day, ${s.periodTimeZone}).`,
    `Proposed by the agent, changeable before you approve: ${usd(s.perCallCeilingUsd)} per call at most.`,
    `Proposed by the agent, changeable before you approve: a ${usd(s.provisionalCeilingUsd)} limit on uncertain charges (calls whose cost Google may have billed but did not confirm).`,
    `The one machine that spends: ${where} (designation ${s.designationEpoch}). Every other machine forwards to it and never spends itself.`,
    `Callers — reviews by Neon (${s.callers.includes('spec-review') ? 'spec-review, on' : 'spec-review, off'}), ${s.e1PassesPerRound} pass per spec round.`,
    `Callers — second opinions by Hydrogen, or Neon on request, from any of my sessions (${s.callers.includes('second-opinion') ? 'second-opinion, on' : 'second-opinion, off'}), limited to ${s.e2MonthSharePct}% of the month (${usd(e2MonthUsd)}) and ${usd(s.e2DayCapUsd)} a day (proposed: change it before approving if you want).`,
    `Callers — background checks: ${s.e3Components.length ? s.e3Components.join(', ') : 'none'}.`,
    `Callers — model-checking tool: ${s.doorwayLivenessOn ? 'on' : 'off'}.`,
    'Step-down: a review steps from Neon to Hydrogen when Neon would not fit under the limits.',
    `Models: ${s.models.join(' and ')} — ${allVerified ? "prices verified on Google's page" : "prices unverified until checked on Google's page"}.`,
    `Key: ${s.keyRef}, kept only on ${where}; Google key id ${s.providerKeyId}; fingerprint ${s.keyGeneration}.`,
    s.googleSpendLimitKind === 'hard-cap'
      ? `Google's own limit on the dedicated project (${s.googleSpendLimitKind}): a hard cap of ${usd(s.googleSpendLimitUsd)} (Google stops there). Instar's own cap is the authority; Google's is the second wall.`
      : `Google's own limit on the dedicated project (${s.googleSpendLimitKind}): a budget alert at ${usd(s.googleSpendLimitUsd)} only. Google will warn but not stop at ${usd(s.googleSpendLimitUsd)}; Instar's own cap is what stops spending.`,
    "Justin's personal Google account is not used.",
    "Conversations cannot run on Gemini in this version.",
    'The door starts armed but waiting for one tiny proof call; ordinary calls run only after the release checks pass.',
    `Monthly invoice check (${GEMINI_PAYG_RECONCILE_JOB}): ${s.reconcileJobEnabled ? 'turned on for this agent' : 'left off'} — the 2nd of each month at 09:00 Pacific, quiet unless the bill and the books disagree.`,
    s.transfer === null ? 'This is a first go-live, not a lane transfer.' : 'This is a lane transfer.',
    'The agent can stop or reduce spending at any time without asking, but cannot raise any limit or add a caller without you.',
    `Approving restarts the agent unless the spending controls are already enforcing on this machine: ${GEMINI_PAYG_RESTART_DISCLOSURE}. You will not be asked for your PIN again for the restart.`,
  ];
  return lines;
}

export function renderGeminiPaygPlanText(s: GeminiPaygSetup, ctx: PlanTextContext, proposalHash: string): string {
  return [...renderGeminiPaygPlanLines(s, ctx), `Proposal ${proposalHash.slice(0, 16)} (${s.schema}, provider ${s.provider}).`].join('\n');
}

// ── The key handoff contract (§4) ───────────────────────────────────

export interface GeminiPaygKeyHandoff {
  noEchoTransfer: { attestedBy: string; at: string; method: string; sourceMessageRef: string };
  oneKeyArtifact: {
    providerKeyId: string;
    keyFingerprint: string;
    readAt: string;
    screenshotPath: string;
    screenshotSha256: string;
    /** Keys with Generative Language access in the project, as read on the key list. Must be 1. */
    keyCount: number;
  };
  googleSpendLimit: { kind: GoogleSpendLimitKind; amountUsd: number; readAt: string; screenshotPath: string; screenshotSha256: string };
  boundTo: { designationEpoch: number };
  /**
   * Every transcript the account-lane run produced (sessions, subagents, the browser
   * tool's output directory), with the lane's attestation that the set is complete. The
   * holder scans them for the stored key's exact value at render.
   */
  transcripts?: { paths: string[]; complete: boolean };
}

const ISO = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const TEXT = (v: unknown, max = 400) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const HEX64 = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const ABS = (v: unknown) => typeof v === 'string' && path.isAbsolute(v) && v.length <= 1000;

/** Shape validation of a handoff body (400 on failure). Returns the error, or null. */
export function validateKeyHandoffBody(b: unknown): string | null {
  if (!b || typeof b !== 'object') return 'body must be an object';
  const h = b as Partial<GeminiPaygKeyHandoff>;
  const n = h.noEchoTransfer;
  if (!n || !TEXT(n.attestedBy, 120) || !ISO(n.at) || !TEXT(n.method, 200) || !TEXT(n.sourceMessageRef, 200)) return 'noEchoTransfer needs attestedBy, at (ISO), method, sourceMessageRef';
  const k = h.oneKeyArtifact;
  if (!k || !TEXT(k.providerKeyId, 200) || !HEX64(k.keyFingerprint) || !ISO(k.readAt) || !ABS(k.screenshotPath) || !HEX64(k.screenshotSha256)) {
    return 'oneKeyArtifact needs providerKeyId, keyFingerprint (sha256 hex), readAt (ISO), screenshotPath (absolute), screenshotSha256';
  }
  if (!Number.isInteger(k.keyCount) || (k.keyCount as number) < 0) return 'oneKeyArtifact.keyCount must be the number of keys read on the project key list';
  const g = h.googleSpendLimit;
  if (!g || (g.kind !== 'hard-cap' && g.kind !== 'budget-alert-only') || typeof g.amountUsd !== 'number' || !Number.isFinite(g.amountUsd) || g.amountUsd <= 0
    || !ISO(g.readAt) || !ABS(g.screenshotPath) || !HEX64(g.screenshotSha256)) {
    return 'googleSpendLimit needs kind (hard-cap | budget-alert-only), amountUsd > 0, readAt (ISO), screenshotPath (absolute), screenshotSha256';
  }
  if (!h.boundTo || !Number.isInteger(h.boundTo.designationEpoch) || h.boundTo.designationEpoch < 1) return 'boundTo.designationEpoch must be a positive integer';
  if (h.transcripts !== undefined) {
    const t = h.transcripts;
    if (!t || !Array.isArray(t.paths) || t.paths.length === 0 || t.paths.length > 500 || t.paths.some((p) => !ABS(p)) || typeof t.complete !== 'boolean') {
      return 'transcripts must be { paths: [absolute paths], complete: boolean }';
    }
  }
  return null;
}

// ── Machine-local files ─────────────────────────────────────────────

export interface StoredSetup { setup: GeminiPaygSetup; hash: string; at: string }

function writeDurable(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
  } catch {
    // @silent-fallback-ok: absent or unparseable reads as "no record"; every caller
    // treats that as a named blocker (awaiting-key, no proposal), never a pass.
    return null;
  }
}

/** The four machine-local go-live files, all under `<stateDir>/state/`. Excluded from backups (§8). */
export class GeminiPaygGoLiveFiles {
  readonly proposalPath: string;
  readonly intentPath: string;
  readonly handoffPath: string;
  readonly mintStartPath: string;
  readonly applyFailurePath: string;
  readonly archiveDir: string;

  constructor(private readonly stateDir: string, private readonly now: () => number = () => Date.now()) {
    const st = path.join(stateDir, 'state');
    this.proposalPath = path.join(st, 'money-proposed-setup.json');
    this.intentPath = path.join(st, 'money-pending-setup.json');
    this.handoffPath = path.join(st, 'gemini-payg-key-handoff.json');
    this.mintStartPath = path.join(st, 'gemini-payg-mint-start.json');
    this.applyFailurePath = path.join(st, 'gemini-payg-apply-failure.json');
    this.archiveDir = path.join(st, 'gemini-payg-archive');
  }

  private readStored(file: string): StoredSetup | null {
    const v = readJson(file) as Partial<StoredSetup> | null;
    if (!v || typeof v !== 'object' || !v.setup || typeof v.hash !== 'string') return null;
    if (validateGeminiPaygSetup(v.setup)) return null;
    // The hash is recomputed: a file whose stored hash does not match its own struct is not a proposal.
    if (geminiPaygSetupHash(v.setup) !== v.hash) return null;
    return { setup: v.setup, hash: v.hash, at: typeof v.at === 'string' ? v.at : '' };
  }

  readProposal(): StoredSetup | null { return this.readStored(this.proposalPath); }
  writeProposal(setup: GeminiPaygSetup): StoredSetup {
    const err = validateGeminiPaygSetup(setup);
    if (err) throw new Error(`invalid setup: ${err}`);
    const rec: StoredSetup = { setup, hash: geminiPaygSetupHash(setup), at: new Date(this.now()).toISOString() };
    writeDurable(this.proposalPath, rec);
    return rec;
  }

  /** True when a file exists at the intent path, whether or not it parses (a corrupt intent is a failed apply, not "none"). */
  intentPresent(): boolean { return fs.existsSync(this.intentPath); }
  readIntent(): StoredSetup | null { return this.readStored(this.intentPath); }
  writeIntent(setup: GeminiPaygSetup, hash: string): void {
    if (geminiPaygSetupHash(setup) !== hash) throw new Error('intent hash does not match its setup');
    writeDurable(this.intentPath, { setup, hash, at: new Date(this.now()).toISOString() });
  }
  deleteIntent(): void {
    if (!fs.existsSync(this.intentPath)) return;
    SafeFsExecutor.safeUnlinkSync(this.intentPath, { operation: 'gemini-payg go-live: intent applied (deleted only after the caps write was fsync\'d)' });
  }

  /** Move a failed intent out of the apply path (kept for the record, never re-applied). */
  archiveIntent(reason: string): void {
    if (!fs.existsSync(this.intentPath)) return;
    fs.mkdirSync(this.archiveDir, { recursive: true });
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    fs.renameSync(this.intentPath, path.join(this.archiveDir, `${stamp}-${reason.replace(/[^a-z0-9-]/gi, '_').slice(0, 40)}-${path.basename(this.intentPath)}`));
  }

  readHandoff(): GeminiPaygKeyHandoff | null {
    const v = readJson(this.handoffPath);
    return v && !validateKeyHandoffBody(v) ? (v as GeminiPaygKeyHandoff) : null;
  }
  handoffPresent(): boolean { return fs.existsSync(this.handoffPath); }
  writeHandoff(h: GeminiPaygKeyHandoff): void { writeDurable(this.handoffPath, h); }

  /** The SERVER-recorded mint start — never a value from the handoff file itself. */
  readMintStart(): number | null {
    const v = readJson(this.mintStartPath) as { at?: unknown } | null;
    const ms = v && typeof v.at === 'string' ? Date.parse(v.at) : NaN;
    return Number.isFinite(ms) ? ms : null;
  }
  recordMintStart(): string {
    const at = new Date(this.now()).toISOString();
    writeDurable(this.mintStartPath, { at });
    return at;
  }

  /**
   * Archive the handoff (and the mint start that vouched for it) so an old attestation
   * can never vouch for a new key (§4 Lifecycle): on commit success, freeze, revoke.
   */
  archiveHandoff(reason: string): boolean {
    let moved = false;
    fs.mkdirSync(this.archiveDir, { recursive: true });
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    for (const f of [this.handoffPath, this.mintStartPath]) {
      if (!fs.existsSync(f)) continue;
      fs.renameSync(f, path.join(this.archiveDir, `${stamp}-${reason.replace(/[^a-z0-9-]/gi, '_').slice(0, 40)}-${path.basename(f)}`));
      moved = true;
    }
    return moved;
  }

  readApplyFailure(): { intentHash: string | null; reason: string; at: string; noticed: boolean } | null {
    const v = readJson(this.applyFailurePath) as { intentHash?: unknown; reason?: unknown; at?: unknown; noticed?: unknown } | null;
    if (!v || typeof v.reason !== 'string') return null;
    return { intentHash: typeof v.intentHash === 'string' ? v.intentHash : null, reason: v.reason, at: String(v.at ?? ''), noticed: v.noticed === true };
  }
  writeApplyFailure(rec: { intentHash: string | null; reason: string; noticed: boolean }): void {
    writeDurable(this.applyFailurePath, { ...rec, at: new Date(this.now()).toISOString() });
  }
}

export function sha256File(file: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    // @silent-fallback-ok: an unreadable screenshot is a named blocker at render, never a match.
    return null;
  }
}

// ── The proposal ────────────────────────────────────────────────────

export interface ProposalOverrides {
  monthlyCapUsd?: number;
  dailyCapUsd?: number;
  perCallCeilingUsd?: number;
  provisionalCeilingUsd?: number;
  e2MonthSharePct?: number;
  e2DayCapUsd?: number;
}

/**
 * Build the proposal on the machine that will spend. Values come from the §5 table
 * (agent-proposed, changeable by overrides before the operator approves); the key's
 * identity comes from the validated handoff; the epoch is the next designation.
 */
export function buildGeminiPaygProposal(args: {
  designatedMachineId: string;
  designatedMachineName: string | null;
  currentDesignationEpoch: number;
  handoff: GeminiPaygKeyHandoff;
  models: string[];
  overrides?: ProposalOverrides;
}): GeminiPaygSetup {
  const o = args.overrides ?? {};
  const d = GEMINI_PAYG_PROPOSED_DEFAULTS;
  return {
    schema: GEMINI_PAYG_SETUP_SCHEMA,
    door: GEMINI_PAYG_DOOR,
    keyRef: GEMINI_PAYG_KEY_REF_NAME,
    provider: 'google',
    designatedMachineId: args.designatedMachineId,
    designatedMachineName: args.designatedMachineName,
    designationEpoch: args.currentDesignationEpoch + 1,
    monthlyCapUsd: o.monthlyCapUsd ?? d.monthlyCapUsd,
    dailyCapUsd: o.dailyCapUsd ?? d.dailyCapUsd,
    periodTimeZone: d.periodTimeZone,
    perCallCeilingUsd: o.perCallCeilingUsd ?? d.perCallCeilingUsd,
    provisionalCeilingUsd: o.provisionalCeilingUsd ?? d.provisionalCeilingUsd,
    e2MonthSharePct: o.e2MonthSharePct ?? d.e2MonthSharePct,
    e2DayCapUsd: o.e2DayCapUsd ?? d.e2DayCapUsd,
    e1PassesPerRound: d.e1PassesPerRound,
    callers: ['spec-review', 'second-opinion'],
    e3Components: [],
    doorwayLivenessOn: false,
    models: [...args.models],
    keyGeneration: args.handoff.oneKeyArtifact.keyFingerprint,
    providerKeyId: args.handoff.oneKeyArtifact.providerKeyId,
    googleSpendLimitKind: args.handoff.googleSpendLimit.kind,
    googleSpendLimitUsd: args.handoff.googleSpendLimit.amountUsd,
    reconcileJobEnabled: true,
    transfer: null,
  };
}

/** The designation epoch currently recorded for the door (0 before any go-live). */
export function currentDesignationEpoch(file: CapsStoreFile | null): number {
  return file?.doorPolicy?.[GEMINI_PAYG_DOOR]?.designationEpoch ?? 0;
}

// ── Render preconditions ────────────────────────────────────────────

export interface PeerSecretNames { machineId: string; outcome: 'names' | 'unreachable' | 'error'; names?: string[]; detail?: string }

export interface RenderPreconditionDeps {
  files: GeminiPaygGoLiveFiles;
  selfMachineId: string;
  /** The stored key's fingerprint, computed inside the named reader. Null = no key in the vault. */
  storedFingerprint: () => Promise<string | null>;
  /** `secret-names` on every registered peer (null = the registry cannot be read). */
  peerSecretNames: () => Promise<PeerSecretNames[] | null>;
  /** A designation naming a DIFFERENT machine this machine has heard or recorded, or null. */
  conflictingDesignation: () => string | null;
  /** The exact-value transcript scan, inside the named reader. */
  scanTranscripts: (paths: string[]) => Promise<{ hit: boolean; unreadable: string[] }>;
  /** `failoverTimeoutMinutes` in ms (the boot check, §6). */
  failoverThresholdMs: () => number;
}

export interface RenderPreconditionResult { ok: boolean; blockers: string[]; awaitingKey: boolean }

/**
 * Every render-time precondition, each a NAMED blocker. A missing, partial or
 * unreachable input is a blocker, never "no hit" (§4, §8).
 */
export async function evaluateGeminiPaygRenderPreconditions(deps: RenderPreconditionDeps, proposal: StoredSetup): Promise<RenderPreconditionResult> {
  const blockers: string[] = [];
  let awaitingKey = false;
  const s = proposal.setup;
  if (s.designatedMachineId !== deps.selfMachineId) blockers.push(`wrong-machine: the plan renders only on ${s.designatedMachineId}`);

  if (!failoverThresholdAllowsArming(deps.failoverThresholdMs())) {
    blockers.push(`failover-threshold-too-short: the failover timeout must be at least ${Math.ceil((2 * WORST_CASE_FENCE_MS) / 1000)}s so an isolated holder fences before another machine could take over`);
  }

  const h = deps.files.readHandoff();
  if (!h) {
    awaitingKey = true;
    blockers.push(deps.files.handoffPresent() ? 'awaiting-key: the key handoff file is malformed' : 'awaiting-key: no key handoff file yet');
  } else {
    const mintStart = deps.files.readMintStart();
    if (mintStart === null) { awaitingKey = true; blockers.push('awaiting-key: no server-recorded mint start'); }
    else {
      if (!(Date.parse(h.oneKeyArtifact.readAt) > mintStart)) { awaitingKey = true; blockers.push('awaiting-key: the one-key read predates the mint start'); }
      if (!(Date.parse(h.googleSpendLimit.readAt) > mintStart)) { awaitingKey = true; blockers.push('awaiting-key: the Google spend-limit read predates the mint start'); }
    }
    if (sha256File(h.oneKeyArtifact.screenshotPath) !== h.oneKeyArtifact.screenshotSha256) { awaitingKey = true; blockers.push('awaiting-key: the one-key screenshot is missing or its hash does not match'); }
    if (sha256File(h.googleSpendLimit.screenshotPath) !== h.googleSpendLimit.screenshotSha256) { awaitingKey = true; blockers.push('awaiting-key: the spend-limit screenshot is missing or its hash does not match'); }
    if (h.oneKeyArtifact.keyCount !== 1) { awaitingKey = true; blockers.push(`second-key-in-project: the project key list shows ${h.oneKeyArtifact.keyCount} keys with Gemini access — exactly one is required (revoke the others first)`); }
    if (h.boundTo.designationEpoch !== s.designationEpoch) { awaitingKey = true; blockers.push(`awaiting-key: the handoff is bound to designation ${h.boundTo.designationEpoch}, the proposal is ${s.designationEpoch}`); }
    if (h.googleSpendLimit.amountUsd > s.monthlyCapUsd) blockers.push(`google-limit-above-cap: Google's limit (${usd(h.googleSpendLimit.amountUsd)}) is above the monthly cap`);
    if (h.oneKeyArtifact.keyFingerprint !== s.keyGeneration || h.oneKeyArtifact.providerKeyId !== s.providerKeyId) blockers.push('proposal-key-mismatch: the proposal names a different key than the handoff');
    if (h.googleSpendLimit.kind !== s.googleSpendLimitKind || h.googleSpendLimit.amountUsd !== s.googleSpendLimitUsd) blockers.push('proposal-limit-mismatch: the proposal names a different Google limit than the handoff');
    const fp = await deps.storedFingerprint();
    if (fp === null) { awaitingKey = true; blockers.push('awaiting-key: no key in this machine\'s vault'); }
    else if (fp !== h.oneKeyArtifact.keyFingerprint) { awaitingKey = true; blockers.push('awaiting-key: the stored key is not the key the handoff attests (fingerprint mismatch)'); }

    if (!h.transcripts) blockers.push('transcript-set-missing: the account lane has not listed its transcripts, so the key cannot be checked against them');
    else if (!h.transcripts.complete) blockers.push('transcript-set-partial: the account lane has not attested its transcript list is complete');
    else {
      const scan = await deps.scanTranscripts(h.transcripts.paths);
      if (scan.unreadable.length) blockers.push(`transcript-unreachable: ${scan.unreadable.length} transcript path(s) could not be read`);
      if (scan.hit) blockers.push('key-in-transcript: the key value appears in an account-lane transcript — re-mint');
    }
  }

  const conflict = deps.conflictingDesignation();
  if (conflict) blockers.push(`conflicting-designation: ${conflict}`);

  const peers = await deps.peerSecretNames();
  if (peers === null) blockers.push('peer-registry-unreadable: the machine registry cannot be read, so the key cannot be shown absent from the other machines');
  else {
    for (const p of peers) {
      if (p.outcome === 'unreachable') continue; // offline: cleared by mint-after-filter (§4)
      if (p.outcome === 'error' || !Array.isArray(p.names)) { blockers.push(`secret-names-unreadable: ${p.machineId}${p.detail ? ` (${p.detail})` : ''}`); continue; }
      if (p.names.some((n) => n === GEMINI_PAYG_KEY_REF_NAME || n.endsWith(`.${GEMINI_PAYG_KEY_REF_NAME}`))) blockers.push(`key-on-peer: ${p.machineId} holds ${GEMINI_PAYG_KEY_REF_NAME} — revoke and re-mint`);
    }
  }
  return { ok: blockers.length === 0, blockers, awaitingKey };
}

// ── Apply (boot or hot) ─────────────────────────────────────────────

export type ApplyOutcome =
  | { kind: 'none' }
  | { kind: 'applied'; intentHash: string }
  | { kind: 'already-applied'; intentHash: string }
  | { kind: 'failed'; intentHash: string | null; reason: string };

export interface ApplyDeps {
  files: GeminiPaygGoLiveFiles;
  capsStore: RoutingSpendCapsStore;
  selfMachineId: string;
  /** True when the money layer's authority log holds the commit row for this intent hash. */
  commitAuditHas: (intentHash: string) => boolean;
  /** One notice on failure (once per intent). */
  notify?: (text: string) => void;
  /** Enable the reconcile job on this agent (best effort). */
  enableReconcileJob?: () => void;
}

/**
 * Apply the pending go-live intent. NEVER THROWS: a failure freezes the door's key,
 * records the failure, raises one notice and returns `failed` — the server keeps
 * booting with the door frozen rather than crash-looping on a bad intent (§8).
 */
export function applyPendingGeminiPaygIntent(d: ApplyDeps): ApplyOutcome {
  if (!d.files.intentPresent()) return { kind: 'none' };
  const intent = d.files.readIntent();
  const fail = (reason: string, intentHash: string | null): ApplyOutcome => {
    try {
      d.capsStore.freeze(`gemini-payg-apply-failed:${reason.slice(0, 60)}`, GEMINI_PAYG_KEY_REF_NAME, {
        provider: 'google', monthlyCapUsd: GEMINI_PAYG_PROPOSED_DEFAULTS.monthlyCapUsd, dailyCapUsd: GEMINI_PAYG_PROPOSED_DEFAULTS.dailyCapUsd, periodTimeZone: GEMINI_PAYG_PROPOSED_DEFAULTS.periodTimeZone,
      });
    } catch (err) {
      // @silent-fallback-ok: NOT silent — logged; with no applied door policy the gate
      // denies the door by default anyway (no go-live record ⇒ skipped).
      console.error(`[instar] gemini-payg apply failed AND the freeze could not be written: ${String(err)}`);
    }
    let noticed = false;
    try {
      const prev = d.files.readApplyFailure();
      noticed = prev?.noticed === true && prev.intentHash === intentHash;
      if (!noticed) d.notify?.(`Gemini go-live could not be applied (${reason}). The Gemini door is frozen, so nothing can spend; the rest of the agent is running normally. A new approval is needed to set it up.`);
      d.files.writeApplyFailure({ intentHash, reason, noticed: true });
      // Archived, so the next boot does not re-freeze the key (which would silently undo
      // an operator's PIN unfreeze). A new go-live needs a new commit.
      d.files.archiveIntent('apply-failed');
    } catch (err) {
      console.error(`[instar] gemini-payg apply-failure record could not be written: ${String(err)}`);
    }
    console.error(`[instar] gemini-payg go-live apply FAILED (door frozen, server continues): ${reason}`);
    return { kind: 'failed', intentHash, reason };
  };
  if (!intent) return fail('the pending setup is unreadable or its hash does not match its contents', null);
  const { setup, hash } = intent;
  try {
    if (setup.designatedMachineId !== d.selfMachineId) return fail(`the setup names machine ${setup.designatedMachineId}, not this one`, hash);
    if (!d.commitAuditHas(hash)) return fail('no PIN-commit record for this setup in the money-layer audit log', hash);
    const file = d.capsStore.read();
    if (file.appliedIntents?.[setup.door]?.intentHash === hash) {
      d.files.deleteIntent();
      return { kind: 'already-applied', intentHash: hash };
    }
    d.capsStore.applyGoLiveSetup('gemini-payg-setup-apply', hash, {
      door: setup.door,
      keyRef: setup.keyRef,
      provider: setup.provider,
      designatedMachineId: setup.designatedMachineId,
      caps: { monthlyCapUsd: setup.monthlyCapUsd, dailyCapUsd: setup.dailyCapUsd, periodTimeZone: setup.periodTimeZone },
      policy: doorPolicyFromSetup(setup),
    });
    // Deleted only after the durable (fsync'd) write above returned.
    d.files.deleteIntent();
    if (setup.reconcileJobEnabled) {
      try { d.enableReconcileJob?.(); } catch (err) { console.error(`[instar] gemini-payg: could not enable the reconcile job: ${String(err)}`); }
    }
    return { kind: 'applied', intentHash: hash };
  } catch (err) {
    return fail(err instanceof Error ? err.message.slice(0, 200) : String(err), hash);
  }
}

/**
 * Turn the reconcile job on for THIS agent: the durable `enabled` lives in the per-slug
 * schedule manifest (the `.md` is regenerated on every update). Best effort; absent
 * manifest ⇒ nothing to flip (the job ships disabled fleet-wide).
 */
export function enableReconcileJobManifest(stateDir: string): boolean {
  const file = path.join(stateDir, 'jobs', 'schedule', `${GEMINI_PAYG_RECONCILE_JOB}.json`);
  const v = readJson(file) as Record<string, unknown> | null;
  if (!v || typeof v !== 'object') return false;
  if (v.enabled === true) return true;
  writeDurable(file, { ...v, enabled: true });
  return true;
}
