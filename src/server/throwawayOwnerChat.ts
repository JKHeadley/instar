/**
 * A stand-in owner chat for throwaway agents (docs/specs/throwaway-owner-chat.md).
 *
 * The approval flows talk to the owner through the owner's private Telegram chat. On a throwaway
 * test agent there is no real owner, so this keeps the owner-chat messages (codes and buttons) in
 * memory and in one log file, and lets a test on this same computer read them and press their
 * buttons through the very handler slots a Telegram tap uses. It is never a messaging adapter and
 * never reaches the network.
 *
 * It exists only when four facts hold, re-read on every use (§2): asked for in the config; the
 * project folder really is under an OS temp root with an unexpired throwaway record; no real owner
 * (no messaging entry or adapter, no owner id, no operator, no introducer, no owner-record
 * enrolment before its first build, no other agent home sharing this machine id); and no other
 * machine. A definitely-false fact shuts it off for good; an unreadable one only withholds it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { accountHomeDir, canonicalPath, isThrowawayExpired, isUnderTempRoot, readThrowawayRecord } from '../core/ThrowawayAgentGuard.js';
import { agentRegistryPath } from '../core/AgentRegistryPaths.js';
import {
  approveTapResult, declineTapResult, OWNER_APPROVE_DATA_RE, OWNER_DECLINE_DATA_RE,
  type OwnerApproveHandler, type OwnerChatButton, type OwnerChatSurface, type OwnerDeclineHandler,
} from '../messaging/ownerChatTap.js';

// ── Files ──────────────────────────────────────────────────────────

export const STAND_IN_LOG = path.join('state', 'throwaway-owner-chat.jsonl');
export const STAND_IN_STATE = path.join('state', 'throwaway-owner-chat.json');

/** True once this agent home has ever built the stand-in: machine pairing stays refused for its life (§2.4). */
export function standInEverUsed(stateDir: string): boolean {
  try { return fs.existsSync(path.join(stateDir, STAND_IN_STATE)); } catch { return true; } // @silent-fallback-ok — unknown counts as used: pairing stays refused
}

/** Telegram's own limits (basis: external-constraint). */
export const MAX_TEXT_UNITS = 4096;
export const MAX_BUTTON_DATA_BYTES = 64;
export const MAX_BUTTONS = 100;
/** A resource budget with wide margin, not a derived floor: a full run writes under 1 MiB. Refuse, never evict. */
export const LOG_BUDGET_BYTES = 16 * 1024 * 1024;
export const PAGE_LIMIT = 200;
/** Room a tap or command needs before it may reach a handler: its result, a confirmation and an edit at the bounds. */
export const ACTION_RESERVE_BYTES = 64 * 1024;
/** One stored message, serialized, at most this: keeps the reserve above any single action's writes (two messages, intents, results, an edit). */
export const MAX_MESSAGE_BYTES = 24 * 1024;

// ── The four conditions ────────────────────────────────────────────

export type StandInCondition =
  | 'not-asked' | 'not-throwaway' | 'real-owner' | 'not-single-machine' | 'shut-off-earlier';

export type StandInVerdict =
  | { ok: true }
  | { ok: false; unsure: false; condition: StandInCondition; detail: string }
  | { ok: false; unsure: true; detail: string };

interface StandInState { firstBuiltAt: string; genesis?: string; off?: { at: string; condition: string; detail: string }; swept?: string }

export interface StandInFacts {
  projectDir: string;
  stateDir: string;
  /** A messaging adapter this server was started with (Telegram, Slack, WhatsApp, iMessage). */
  adapterStarted: () => boolean;
  now?: () => number;
  /** The account's real home (tests point it elsewhere). */
  accountHome?: string;
  /** The account-wide agent registry files to read (tests point them elsewhere). */
  agentRegistryFiles?: () => string[];
}

class Unsure extends Error {}

function readJsonFile(file: string): unknown | undefined {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
    // Missing (or a path through something that is not a folder): an ordinary "not there".
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw new Unsure(`${path.basename(file)} could not be read`);
  }
  try { return JSON.parse(raw); } catch { throw new Unsure(`${path.basename(file)} could not be parsed`); }
}

function readState(stateDir: string): StandInState | null {
  const v = readJsonFile(path.join(stateDir, STAND_IN_STATE));
  if (v === undefined) return null;
  if (!v || typeof v !== 'object' || typeof (v as StandInState).firstBuiltAt !== 'string') throw new Unsure('stand-in state is malformed');
  return v as StandInState;
}

function writeState(stateDir: string, st: StandInState): void {
  const file = path.join(stateDir, STAND_IN_STATE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Every other agent home on this computer: the account-wide registry (real home and $HOME) and ~/.instar/agents/*. */
function otherAgentHomes(facts: StandInFacts, accountHome: string): string[] {
  const homes = new Set<string>();
  const registryFiles = facts.agentRegistryFiles?.() ?? [path.join(accountHome, '.instar', 'registry.json'), agentRegistryPath()];
  for (const f of registryFiles) {
    try {
      const reg = JSON.parse(fs.readFileSync(f, 'utf8')) as { entries?: Array<{ path?: unknown }> };
      for (const e of reg.entries ?? []) if (typeof e?.path === 'string') homes.add(e.path);
    } catch { /* @silent-fallback-ok — a missing or unreadable registry lists nobody; the agents folder is read too */ }
  }
  const agentsDir = path.join(accountHome, '.instar', 'agents');
  try { for (const d of fs.readdirSync(agentsDir, { withFileTypes: true })) if (d.isDirectory()) homes.add(path.join(agentsDir, d.name)); } catch { /* @silent-fallback-ok — no agents folder */ }
  const self = canonicalPath(facts.projectDir);
  return [...homes].filter((h) => canonicalPath(h) !== self);
}

/** A home's machine id; null when it has no identity file. An identity file that exists but cannot be read is unsure. */
function machineIdOf(stateDir: string): string | null {
  const v = readJsonFile(path.join(stateDir, 'machine', 'identity.json')) as { machineId?: unknown } | undefined;
  return v && typeof v.machineId === 'string' ? v.machineId : null;
}

/**
 * Read the four conditions from the agent's own files (§2). Pure apart from file reads, plus one write:
 * the state file at first build (only when no owner enrolment exists yet), and the adopted genesis.
 */
export function evaluateStandIn(facts: StandInFacts, opts: { firstBuild?: boolean } = {}): StandInVerdict {
  const now = facts.now?.() ?? Date.now();
  const accountHome = facts.accountHome ?? accountHomeDir();
  const refuse = (condition: StandInCondition, detail: string): StandInVerdict => ({ ok: false, unsure: false, condition, detail });
  try {
    // 2 (location half) first: it reads no file, so a real agent is refused definitely, never "unsure".
    // The real path only: isUnderTempRoot alone also accepts the unresolved path, so a temp-folder symlink to a real home would pass.
    if (!isUnderTempRoot(canonicalPath(facts.projectDir), accountHome)) return refuse('not-throwaway', 'the project folder is not under a temporary folder');
    if (!within(canonicalPath(facts.stateDir), canonicalPath(facts.projectDir))) return refuse('not-throwaway', 'the state folder is outside the project folder');
    const cfg = readJsonFile(path.join(facts.stateDir, 'config.json')) as Record<string, any> | undefined;
    const state = readState(facts.stateDir);
    if (state?.off) return refuse('shut-off-earlier', `shut off earlier (${state.off.condition})`);
    // 1. Asked for.
    if (cfg?.liveTest?.throwawayOwnerChat?.enabled !== true) return refuse('not-asked', 'liveTest.throwawayOwnerChat.enabled is not true');
    // 2 (record half): an unexpired throwaway record.
    const record = readThrowawayRecord(facts.projectDir);
    if (!record || record.expiresAt === undefined || record.keep) return refuse('not-throwaway', 'no expiring throwaway record');
    const created = Date.parse(record.createdAt);
    if (!Number.isFinite(created) || created > now) return refuse('not-throwaway', 'the throwaway record was created in the future');
    if (isThrowawayExpired(record, now)) return refuse('not-throwaway', 'the throwaway record has expired');
    // 3. No real owner.
    if (cfg && cfg.messaging !== undefined && (!Array.isArray(cfg.messaging) || cfg.messaging.length > 0)) return refuse('real-owner', 'a messaging adapter is configured');
    if (facts.adapterStarted()) return refuse('real-owner', 'a messaging adapter is running');
    if (cfg?.monitoring?.promptGate?.ownerId != null) return refuse('real-owner', 'an owner id is configured');
    const introducers = cfg?.mobilePairing?.ownerIntroducers;
    if (introducers !== undefined && (!Array.isArray(introducers) || introducers.length > 0)) return refuse('real-owner', 'an owner introducer is configured');
    const operators = readJsonFile(path.join(facts.stateDir, 'state', 'topic-operators.json'));
    if (operators !== undefined && (typeof operators !== 'object' || operators === null || Object.keys(operators).length > 0)) return refuse('real-owner', 'a verified operator is recorded');
    const marker = readJsonFile(path.join(facts.stateDir, 'machine', 'owner-record-enrolled.json')) as { at?: unknown; genesis?: unknown } | undefined;
    let ownerKeyEntry = false;
    try {
      ownerKeyEntry = /"kind"\s*:\s*"add-owner-key"/.test(fs.readFileSync(path.join(facts.stateDir, 'state', 'owner-record', 'entries.jsonl'), 'utf8'));
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Unsure('the owner record could not be read'); }
    const enrolled = marker !== undefined || ownerKeyEntry;
    // At first build no device may exist yet: an owner phone could approve and enrol without the stand-in.
    if (!state) {
      const devices = readJsonFile(path.join(facts.stateDir, 'state', 'mobile-devices.json')) as { devices?: unknown } | undefined;
      if (devices !== undefined && (!devices || !Array.isArray(devices.devices) || devices.devices.length > 0)) return refuse('real-owner', 'a device was paired before the stand-in was first built');
    }
    let current = state;
    if (enrolled) {
      if (!current) return refuse('real-owner', 'the owner record was enrolled before the stand-in was first built');
      if (marker !== undefined) {
        const at = typeof marker?.at === 'string' ? Date.parse(marker.at) : NaN;
        if (!Number.isFinite(at) || at < Date.parse(current.firstBuiltAt)) return refuse('real-owner', 'the owner record was enrolled before the stand-in was first built');
        const genesis = typeof marker?.genesis === 'string' ? marker.genesis : '';
        if (current.genesis && current.genesis !== genesis) return refuse('real-owner', 'the owner record changed to a different genesis');
        if (!current.genesis && genesis) { current = { ...current, genesis }; writeState(facts.stateDir, current); }
      }
    }
    const selfId = machineIdOf(facts.stateDir);
    if (selfId) for (const home of otherAgentHomes(facts, accountHome)) {
      if (machineIdOf(path.join(home, '.instar')) === selfId) return refuse('real-owner', 'another agent home on this computer has the same machine identity');
    }
    // 4. Only this machine.
    const registry = readJsonFile(path.join(facts.stateDir, 'machine', 'registry.json')) as { machines?: Record<string, unknown> } | undefined;
    const peers = Object.keys(registry?.machines ?? {}).filter((id) => id !== selfId);
    if (peers.length > 0) return refuse('not-single-machine', 'another machine is registered');
    if (opts.firstBuild && !current) writeState(facts.stateDir, { firstBuiltAt: new Date(now).toISOString() });
    return { ok: true };
  } catch (err) {
    if (err instanceof Unsure) return { ok: false, unsure: true, detail: err.message };
    return { ok: false, unsure: true, detail: err instanceof Error ? err.message : String(err) };
  }
}

// ── The stand-in ───────────────────────────────────────────────────

export interface StandInMessage {
  kind: 'message'; id: number; at: string; text: string; buttons: OwnerChatButton[]; buttonsLive: boolean;
}
export type StandInEntry =
  | StandInMessage
  | { kind: 'tap-intent'; id: number; at: string; messageId: number; button: number; data: string }
  | { kind: 'tap'; id: number; at: string; messageId: number; button: number; data: string; outcome: string; toast: string; intentId?: number }
  | { kind: 'edit'; id: number; at: string; messageId: number; text?: string; buttonsRemoved: true }
  | { kind: 'command-intent'; id: number; at: string; text: string }
  | { kind: 'command'; id: number; at: string; text: string; replyId: number | null; intentId?: number }
  | { kind: 'shut-off'; id: number; at: string; condition: string; detail: string }
  | { kind: 'refused'; id: number; at: string; reason: string };

export type ApproverResetHandler = (args: string) => { text: string; buttons?: OwnerChatButton[] };

export type RouteAnswer = { status: number; body: Record<string, unknown> };

export interface ThrowawayOwnerChatDeps extends StandInFacts {
  log?: (line: string) => void;
}

export class ThrowawayOwnerChat implements OwnerChatSurface {
  mobileApproveHandler: OwnerApproveHandler | null = null;
  mobileDeclineHandler: OwnerDeclineHandler | null = null;
  /** identity-security piece 3d fills this, as it does on TelegramAdapter. */
  approverResetHandler: ApproverResetHandler | null = null;

  private readonly entries: StandInEntry[] = [];
  private readonly messagesById = new Map<number, StandInMessage>();
  private readonly hooks = new Map<string, () => void>();
  private nextId = 1;
  private bytes = 0;
  /** The log file ends mid-line (a crash during a write): the next append starts on a new line. */
  private tornTail = false;
  private off = false;
  /** Whether the stand-in was not definitely off at boot (routes are mounted only then; they gate per use). */
  readonly builtLive: boolean;
  readonly bootVerdict: StandInVerdict;

  constructor(private readonly deps: ThrowawayOwnerChatDeps) {
    this.loadLog();
    this.bootVerdict = evaluateStandIn(deps, { firstBuild: true });
    this.builtLive = this.bootVerdict.ok || this.bootVerdict.unsure;
    // A definitely-false condition at boot: off for good. The sweep waits for AgentServer to wire the handlers (finishShutOff).
    if (!this.bootVerdict.ok && !this.bootVerdict.unsure) this.recordOff(this.bootVerdict.condition, this.bootVerdict.detail);
  }

  /**
   * Build the stand-in only for a home that asked for it or ran it before (a home that ran it before
   * still needs its shut-off sweep). Anything else: null, and nothing is read further.
   */
  static forBoot(deps: ThrowawayOwnerChatDeps): ThrowawayOwnerChat | null {
    let asked = false;
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(deps.stateDir, 'config.json'), 'utf8')) as { liveTest?: { throwawayOwnerChat?: { enabled?: unknown } } };
      asked = cfg?.liveTest?.throwawayOwnerChat?.enabled === true;
    } catch { /* @silent-fallback-ok — an unreadable config never asks for the stand-in */ }
    if (!asked && !standInEverUsed(deps.stateDir)) return null;
    const chat = new ThrowawayOwnerChat(deps);
    const v = chat.bootVerdict;
    deps.log?.(v.ok ? '[throwaway-owner-chat] built: the stand-in owner chat is on for this throwaway agent'
      : `[throwaway-owner-chat] not built: ${v.unsure ? 'a condition could not be read' : `condition ${v.condition}`} (${v.detail})`);
    return chat;
  }

  /** Register a piece's shut-off step (named, synchronous; a failing hook is logged and the rest still run). */
  onShutOff(name: string, fn: () => void): void { this.hooks.set(name, fn); }

  /** True while every condition holds; a definitely-false condition shuts the stand-in off for good. */
  live(): boolean { return this.gate() === 'ok'; }

  /** Owner presence for the approval path: live or unsure (a failed read never flips the channel); false once off. */
  ownerChatPresent(): boolean { return this.gate() !== 'off'; }

  /** Definitely off (shut off, or refused at boot); does not re-read the conditions. */
  isOff(): boolean { return this.off; }

  private gate(): 'ok' | 'off' | 'unsure' {
    if (this.off) return 'off';
    // The first build is recorded at the first use whose conditions all hold (boot may have been unsure).
    const v = evaluateStandIn(this.deps, { firstBuild: true });
    if (v.ok) return 'ok';
    if (v.unsure) return 'unsure';
    this.shutOff(v.condition, v.detail);
    return 'off';
  }

  /**
   * Shut off for good (§2): record `off` first, press Decline on every live md:d: button through the
   * decline slot, mark other live buttons removed, run the pieces' hooks.
   */
  private shutOff(condition: string, detail: string): void {
    this.recordOff(condition, detail);
    this.finishShutOff();
  }

  /** Step 1 of shutting off: record `off` before anything else, so nothing re-enters the stand-in. */
  private recordOff(condition: string, detail: string): void {
    this.off = true;
    let st: StandInState | null = null;
    try { st = readState(this.deps.stateDir); } catch { /* @silent-fallback-ok — handled below as unrecorded */ }
    if (!st) return; // never built here: nothing to record or end
    if (st.off) return; // already recorded
    try {
      writeState(this.deps.stateDir, { ...st, off: { at: this.iso(), condition, detail } });
    } catch (err) { this.deps.log?.(`[throwaway-owner-chat] could not record the shut-off: ${err instanceof Error ? err.message : String(err)}`); }
    this.append({ kind: 'shut-off', id: 0, at: this.iso(), condition, detail }, true);
    this.deps.log?.(`[throwaway-owner-chat] shut off for good: condition ${condition} (${detail})`);
  }

  /**
   * The sweep, run once the handlers and hooks are wired (AgentServer calls it after the mobile wiring,
   * and the stand-in runs it again on every later shut-off). Recorded so it runs once per shut-off.
   */
  finishShutOff(): void {
    if (!this.off) return;
    let st: StandInState | null = null;
    try { st = readState(this.deps.stateDir); } catch { /* @silent-fallback-ok — an unreadable state is not swept now; the next boot or use tries again */ }
    if (!st) return; // never built here (or unreadable now): nothing to sweep yet
    if (st.swept) return;
    for (const m of this.messagesById.values()) {
      if (!m.buttonsLive) continue;
      for (const b of m.buttons) {
        const d = OWNER_DECLINE_DATA_RE.exec(b.data);
        if (!d || !this.mobileDeclineHandler) continue;
        try { this.mobileDeclineHandler(d[1]!); } catch (err) { this.deps.log?.(`[throwaway-owner-chat] a Decline during shut-off failed: ${err instanceof Error ? err.message : String(err)}`); }
      }
      m.buttonsLive = false;
      this.append({ kind: 'edit', id: 0, at: this.iso(), messageId: m.id, buttonsRemoved: true }, true);
    }
    let allDone = true;
    for (const [name, fn] of this.hooks) {
      try { fn(); } catch (err) { allDone = false; this.deps.log?.(`[throwaway-owner-chat] shut-off step ${name} failed; it runs again at the next start: ${err instanceof Error ? err.message : String(err)}`); }
    }
    if (!allDone) return;
    try { writeState(this.deps.stateDir, { ...readState(this.deps.stateDir) ?? st, swept: this.iso() }); } catch { /* @silent-fallback-ok — the next boot sweeps again; re-pressing Decline on ended pairings is harmless */ }
  }

  // ── The owner-chat surface ───────────────────────────────────────

  async sendOwnerDMWithButton(text: string, button: OwnerChatButton | OwnerChatButton[] | null): Promise<number | null> {
    if (this.gate() !== 'ok') return null;
    return this.store(text, Array.isArray(button) ? button : button ? [button] : []);
  }

  /** `admitted`: a result of an action already admitted under the reserve, written even past the budget. */
  private store(text: string, buttons: OwnerChatButton[], admitted = false): number | null {
    if (typeof text !== 'string' || text.length > MAX_TEXT_UNITS || buttons.length > MAX_BUTTONS) return null;
    for (const b of buttons) {
      if (!b || typeof b.text !== 'string' || typeof b.data !== 'string' || Buffer.byteLength(b.data, 'utf8') > MAX_BUTTON_DATA_BYTES || b.data.length === 0) return null;
    }
    const m: StandInMessage = { kind: 'message', id: 0, at: this.iso(), text, buttons: buttons.map((b) => ({ text: b.text, data: b.data })), buttonsLive: buttons.length > 0 };
    if (Buffer.byteLength(JSON.stringify(m), 'utf8') > MAX_MESSAGE_BYTES) return null;
    if (!this.append(m, admitted)) return null;
    this.messagesById.set(m.id, m);
    return m.id;
  }

  // ── Routes (each already passed the route gate) ──────────────────

  private routeGate(): RouteAnswer | null {
    const g = this.gate();
    if (g === 'off') return { status: 410, body: { error: 'stand-in-off' } };
    if (g === 'unsure') return { status: 503, body: { error: 'stand-in-unsure' } };
    return null;
  }

  messages(after: number): RouteAnswer {
    const refused = this.routeGate();
    if (refused) return refused;
    const finished = new Set(this.entries.flatMap((e) => ((e.kind === 'tap' || e.kind === 'command') && typeof e.intentId === 'number' ? [e.intentId] : [])));
    const all = this.entries.filter((e) => e.id > after);
    const page = all.slice(0, PAGE_LIMIT);
    return {
      status: 200,
      body: {
        entries: page.map((e) => (e.kind === 'message' ? { ...e, buttons: e.buttons.map((b, i) => ({ index: i, text: b.text, data: b.data })) }
          : e.kind === 'tap-intent' || e.kind === 'command-intent' ? { ...e, indeterminate: !finished.has(e.id) } : e)),
        more: all.length > page.length,
      },
    };
  }

  tap(messageId: unknown, button: unknown): RouteAnswer {
    const refused = this.routeGate();
    if (refused) return refused;
    const m = typeof messageId === 'number' ? this.messagesById.get(messageId) : undefined;
    if (!m || typeof button !== 'number' || !Number.isInteger(button) || !m.buttons[button]) return { status: 404, body: { error: 'no-such-button' } };
    if (!m.buttonsLive) return { status: 409, body: { error: 'buttons-removed' } };
    const data = m.buttons[button]!.data;
    const a = OWNER_APPROVE_DATA_RE.exec(data);
    const d = OWNER_DECLINE_DATA_RE.exec(data);
    if (this.bytes + ACTION_RESERVE_BYTES > LOG_BUDGET_BYTES) return { status: 507, body: { error: 'stand-in-full' } };
    if (!a && !d) {
      this.appendOrFull({ kind: 'tap', id: 0, at: this.iso(), messageId: m.id, button, data, outcome: 'button-not-handled', toast: '' });
      return { status: 409, body: { error: 'button-not-handled', detail: 'Telegram\'s approval path does not act on this button either.' } };
    }
    // Intent before the handler, result after: a crash between them leaves an unmatched intent, reported as indeterminate.
    const intent: StandInEntry = { kind: 'tap-intent', id: 0, at: this.iso(), messageId: m.id, button, data };
    this.appendOrFull(intent);
    if (a) {
      const r = this.mobileApproveHandler ? this.mobileApproveHandler(a[1]!) : { outcome: 'ended' as const, text: 'This pairing has already ended.' };
      const shown = approveTapResult(r);
      this.appendOrFull({ kind: 'tap', id: 0, at: this.iso(), messageId: m.id, button, data, outcome: r.outcome, toast: shown.toast, intentId: intent.id });
      let confirmationId: number | null = null;
      if (shown.approved) {
        if (shown.removeButtons) { m.buttonsLive = false; this.appendOrFull({ kind: 'edit', id: 0, at: this.iso(), messageId: m.id, buttonsRemoved: true }); }
        if (shown.confirmation) confirmationId = this.store(shown.confirmation, [], true);
      }
      return { status: 200, body: { outcome: r.outcome, toast: shown.toast, buttonsRemoved: !m.buttonsLive, confirmationId } };
    }
    const raw = this.mobileDeclineHandler ? this.mobileDeclineHandler(d![1]!) : 'unknown';
    const shown = declineTapResult(raw);
    const outcome = typeof raw === 'string' ? raw : raw.result;
    this.appendOrFull({ kind: 'tap', id: 0, at: this.iso(), messageId: m.id, button, data, outcome, toast: shown.toast, intentId: intent.id });
    if (shown.replaceText) {
      // Replacing the text removes the buttons too, as editMessageText without a keyboard does.
      m.text = shown.replaceText; m.buttonsLive = false;
      this.appendOrFull({ kind: 'edit', id: 0, at: this.iso(), messageId: m.id, text: shown.replaceText, buttonsRemoved: true });
    }
    return { status: 200, body: { outcome, toast: shown.toast, buttonsRemoved: !m.buttonsLive } };
  }

  command(text: unknown): RouteAnswer {
    const refused = this.routeGate();
    if (refused) return refused;
    if (typeof text !== 'string' || text.length > MAX_TEXT_UNITS || !/^\/approver_reset(\s|$)/.test(text)) return { status: 400, body: { error: 'only-approver-reset' } };
    if (!this.approverResetHandler) return { status: 409, body: { error: 'not-wired' } };
    if (this.bytes + ACTION_RESERVE_BYTES > LOG_BUDGET_BYTES) return { status: 507, body: { error: 'stand-in-full' } };
    const intent: StandInEntry = { kind: 'command-intent', id: 0, at: this.iso(), text };
    this.appendOrFull(intent);
    const r = this.approverResetHandler(text.replace(/^\/approver_reset/, '').trim());
    const replyId = this.store(r.text, r.buttons ?? [], true);
    this.appendOrFull({ kind: 'command', id: 0, at: this.iso(), text, replyId, intentId: intent.id });
    if (replyId === null) {
      this.appendOrFull({ kind: 'refused', id: 0, at: this.iso(), reason: 'reply-over-bounds' });
      return { status: 500, body: { error: 'reply-over-bounds' } };
    }
    return { status: 200, body: { replyId } };
  }

  // ── The log ──────────────────────────────────────────────────────

  private iso(): string { return new Date(this.deps.now?.() ?? Date.now()).toISOString(); }

  /** Results of an admitted action: the reserve guarantees room, and they are written even past the budget. */
  private appendOrFull(e: StandInEntry): void { this.append(e, true); }

  /** Append one entry (id assigned here); refuses past the budget unless `force` (shut-off records). */
  private append(e: StandInEntry, force = false): boolean {
    e.id = this.nextId;
    const line = (this.tornTail ? '\n' : '') + JSON.stringify(e) + '\n';
    const size = Buffer.byteLength(line, 'utf8');
    if (!force && this.bytes + size > LOG_BUDGET_BYTES) return false;
    try {
      const file = path.join(this.deps.stateDir, STAND_IN_LOG);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch (err) {
      this.deps.log?.(`[throwaway-owner-chat] could not write the log: ${err instanceof Error ? err.message : String(err)}`);
      if (!force) return false;
    }
    this.tornTail = false;
    this.nextId += 1;
    this.bytes += size;
    this.entries.push(e);
    return true;
  }

  /** Replay the log at boot, so a restart keeps the messages and their live buttons. */
  private loadLog(): void {
    let raw = '';
    try { raw = fs.readFileSync(path.join(this.deps.stateDir, STAND_IN_LOG), 'utf8'); } catch { return; } // @silent-fallback-ok — no log yet
    this.tornTail = raw.length > 0 && !raw.endsWith('\n');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let e: StandInEntry;
      try { e = JSON.parse(line) as StandInEntry; } catch { continue; } // @silent-fallback-ok — a torn last line from a crash
      if (!e || typeof e.id !== 'number') continue;
      this.bytes += Buffer.byteLength(line, 'utf8') + 1;
      this.nextId = Math.max(this.nextId, e.id + 1);
      if (e.kind === 'message') { this.messagesById.set(e.id, e); this.entries.push(e); continue; }
      if (e.kind === 'edit') {
        const m = this.messagesById.get(e.messageId);
        if (m) { m.buttonsLive = false; if (typeof e.text === 'string') m.text = e.text; }
      }
      this.entries.push(e);
    }
  }
}
