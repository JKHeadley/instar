/**
 * Server wiring for Never-Silent Conversation (docs/specs/never-silent-conversation.md).
 * Turns the server's live objects into the watcher's injected deps, so server.ts only
 * hands over closures and the logic stays unit-testable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { NeverSilentStore, type ConversationPlatform } from './NeverSilentStore.js';
import { NOTICE_HELD_REASONS, NeverSilentWatcher, parseAskCallback, type NeverSilentConfig, type NeverSilentDeps, type NeverSilentNeed, type NoticeUndelivered, type SessionFacts } from './NeverSilentWatcher.js';
import { ConversationSilenceJudge, type RefereeRoute } from './ConversationSilenceJudge.js';
import { ENGINE_LOGIN_READERS } from '../../providers/adapters/engineSessionHooks.js';
import type { IntelligenceFramework } from '../../core/intelligenceProviderFactory.js';
import { classifyLoginExpired } from '../../core/LoginExpiredSignature.js';
import { isSystemOrProxyMessage } from '../../messaging/shared/isSystemOrProxyMessage.js';
import type { IntelligenceProvider } from '../../core/types.js';

export const NEVER_SILENT_SYSTEM_PRINCIPAL = 'system:never-silent';
/**
 * The move back restores the operator's engine choice under this system label (never in the
 * operator's name — that would count as a fresh operator write and clear parked profiles and
 * breaker counts). A conversation carrying it is still treated as pinned.
 */
export const NEVER_SILENT_RESTORED_PIN_PREFIX = 'system:never-silent:restored-pin:';

export interface PoolAccountLike {
  id: string;
  framework: string;
  configHome: string;
  status: string;
  statusCause?: string | null;
}

export interface NeverSilentWiringInput {
  stateDir: string;
  logsDir: string;
  config: () => NeverSilentConfig;
  // sessions
  sessionForTelegramTopic: (topicId: number) => string | null;
  sessionForSlackChannel: (channelId: string) => string | null;
  sessionFacts: (tmuxSession: string) => Omit<SessionFacts, 'tmuxSession'> | null;
  /** The machine this conversation's waiting message is held for in the inbound queue, or null. */
  awaitingMachineFor?: (platform: ConversationPlatform, key: string) => string | null;
  isProtected: (tmuxSession: string) => boolean;
  capturePane: (tmuxSession: string) => string | null;
  // pool
  poolAccounts: () => PoolAccountLike[];
  loginCheck: (accountId: string) => string | null;
  observeLoginExpired: (configHome: string, tmuxSession: string) => Promise<string | void | { reason: string; probe?: 'ok' | 'refused' | 'pending' | 'inconclusive' }>;
  /** Spec stale-process-login-expired: is an in-place refresh in progress or still possible for this session? */
  inPlaceRefreshPossible?: (tmuxSession: string, accountId: string | null) => boolean;
  repairStarted: (accountId: string | null) => boolean;
  swap: (session: SessionFacts) => Promise<{ swapped: boolean; reason?: string }>;
  // topic profile (Telegram topics only)
  profileFor: (topicId: number) => { framework?: string | null; updatedBy?: string } | null;
  writeFramework: (topicId: number, framework: string | null, updatedBy: string) => Promise<boolean>;
  respawnTopic: (topicId: number, tmuxSession: string | null, text: string) => Promise<boolean>;
  // judge
  readJevKey: () => string | null;
  /** A referee provider for an engine (built once per engine by the caller), or null when that engine has none. */
  refereeFor: (framework: string) => IntelligenceProvider | null;
  // notices
  sendTelegramNotice: (topicId: number, text: string, inboundMessageId: string, button?: { text: string; data: string }) => Promise<string | null | NoticeUndelivered>;
  sendSlackNotice: (channelId: string, text: string) => Promise<string | null | NoticeUndelivered>;
  /** Shared feature-evidence log (the maturation ladder reads it). */
  evidence?: (kind: 'fired' | 'error', reason: string, context: Record<string, unknown>) => void;
  /** Needs-you fallback for a notice that keeps failing (CMT-2078 step 3); absent = none on this agent. */
  raiseNeed?: NeverSilentDeps['raiseNeed'];
  clearNeed?: NeverSilentDeps['clearNeed'];
  now?: () => number;
}

export interface NeverSilentWiring {
  store: NeverSilentStore;
  watcher: NeverSilentWatcher;
  /** Feed one logged conversation row. */
  observeLogged: (platform: ConversationPlatform, key: string, row: { messageId: string; text: string; fromUser: boolean; provenance?: string; senderName?: string }) => void;
  handleTelegramTap: (tap: { data: string; fromIsOwner: boolean }) => Promise<string>;
  start: (intervalMs?: number) => void;
  stop: () => void;
}

const isHealthy = (a: PoolAccountLike, loginCheck: string | null): boolean =>
  a.status === 'active' && loginCheck !== 'signed-out';

/**
 * How a watcher event counts for the feature's evidence (its error rate). CMT-2078: a failed waiting
 * or status notice counts as one error per failure streak of an incident and notice kind (the row
 * the watcher marks `firstFailure`), and a notice the gate held quiet or that came back with no
 * message id is neither an error nor a send. Every try is still written to the never-silent log, so
 * the per-try count stays readable beside this one. A row without a try number (the one-off
 * move-failed notice) counts as an error unless it was held.
 */
export function neverSilentEvidenceKind(event: Record<string, unknown>): 'fired' | 'error' | null {
  if (event.event === 'notice-sent' || event.event === 'fallback-applied') return 'fired';
  if (event.event === 'handle-failed' || event.event === 'sweep-failed') return 'error';
  if (event.event !== 'notice-undelivered') return null;
  if (typeof event.reason === 'string' && NOTICE_HELD_REASONS.has(event.reason)) return null;
  if (typeof event.attempt === 'number') return event.firstFailure === true ? 'error' : null;
  return 'error';
}

/** Plain words for a bounded undelivered reason, for the person's Needs-you list. */
const NEED_REASON_WORDS: Record<string, string> = {
  'no-adapter': 'the agent had no connection to that chat service',
  'no-receipt': 'the chat service gave no answer',
  'unknown-reason': 'the send did not go through',
  'held-quiet': 'it was held as a quiet notification',
  'no-message-id': 'the chat service did not confirm it',
};

/**
 * The attention item for a never-silent notice that keeps failing (CMT-2078 step 3). The
 * conversation goes in the title and the detail, because the Needs-you list shows only those two
 * and groups rows by title, so each waiting conversation is its own row. Never message text.
 * `source: 'agent'` is what admits it to the list (dashboard/console/home-model.js needsOperator).
 */
export function neverSilentNeedItem(need: NeverSilentNeed): {
  id: string; category: string; priority: 'HIGH'; source: 'agent'; sourceContext: string; title: string; summary: string; description: string;
} {
  // A Slack channel keeps its id so two waiting channels stay two rows (the list groups by title).
  const where = need.platform === 'telegram' ? `topic ${need.conversationKey}` : `Slack conversation ${need.conversationKey.slice(0, 40)}`;
  const reasonWords = NEED_REASON_WORDS[need.reason] ?? (need.reason.startsWith('threw:') ? 'the send failed with an error' : 'the send did not go through');
  return {
    id: need.id, category: 'never-silent', priority: 'HIGH', source: 'agent', sourceContext: 'never-silent-notice',
    title: `A message in ${where} is waiting, and the agent could not say so there`,
    summary: `Someone is waiting for a reply in ${where}. The agent tried ${need.tries} times to post a short "still working on it" notice there and could not, so they may think they were ignored.`,
    description: `Someone is waiting for a reply in ${where}. The agent tried ${need.tries} times to tell them it is still working on it, and ${reasonWords}. Open that conversation to answer. This item closes by itself once a notice gets through or the message is answered.`,
  };
}

export function buildNeverSilent(input: NeverSilentWiringInput): NeverSilentWiring {
  const now = input.now ?? (() => Date.now());
  const store = new NeverSilentStore(input.stateDir, now);
  const logPath = path.join(input.logsDir, 'never-silent.jsonl');
  const healthy = (fw?: string, exclude?: string | null) => input.poolAccounts()
    .filter((a) => (!fw || a.framework === fw) && a.id !== exclude && isHealthy(a, input.loginCheck(a.id)));

  /** Engines with at least one signed-in account, most accounts first (engine-neutral: read from the pool). */
  const healthyEngines = (): string[] => {
    const n = new Map<string, number>();
    for (const a of healthy()) n.set(a.framework, (n.get(a.framework) ?? 0) + 1);
    return [...n.entries()].sort((x, y) => y[1] - x[1]).map(([fw]) => fw);
  };

  const pickReferee = (stuck: { framework: string | null; accountId: string | null }): RefereeRoute | null => {
    // Never the stuck framework+account. A different engine first (§3.2 rung 2), then a different
    // signed-in account on the same engine (rung 3).
    const engines = healthyEngines();
    const ordered = [...engines.filter((fw) => fw !== stuck.framework), ...engines.filter((fw) => fw === stuck.framework)];
    for (const fw of ordered) {
      const provider = input.refereeFor(fw);
      if (!provider) continue;
      const acct = healthy(fw, fw === stuck.framework ? stuck.accountId : null)[0];
      if (acct) return { name: `${fw}:${acct.id}`, provider, accountOverride: { accountId: acct.id, configHome: acct.configHome } };
    }
    return null;
  };

  const judge = new ConversationSilenceJudge({ readJevKey: input.readJevKey, pickReferee });

  const resolve = (platform: ConversationPlatform, key: string): SessionFacts | null => {
    const tmux = platform === 'telegram' ? input.sessionForTelegramTopic(Number(key)) : input.sessionForSlackChannel(key);
    if (!tmux) return null;
    const f = input.sessionFacts(tmux);
    return f ? { tmuxSession: tmux, ...f } : null;
  };

  const watcher = new NeverSilentWatcher({
    store,
    config: input.config,
    judge,
    resolveSession: resolve,
    ...(input.awaitingMachineFor ? { awaitingMachine: input.awaitingMachineFor } : {}),
    capturePane: input.capturePane,
    authStatus: async (framework, configHome) => {
      const reader = framework ? ENGINE_LOGIN_READERS[framework as IntelligenceFramework] : undefined;
      if (!reader || !configHome) return null;
      return reader(configHome);
    },
    accountFacts: (id) => {
      if (!id) return null;
      const a = input.poolAccounts().find((x) => x.id === id);
      return a ? { id, status: a.status, loginCheck: input.loginCheck(id), statusCause: a.statusCause ?? null } : { id, status: null, loginCheck: null };
    },
    healthyByFramework: () => {
      const out: Record<string, number> = {};
      for (const a of healthy()) out[a.framework] = (out[a.framework] ?? 0) + 1;
      return out;
    },
    sameEngineHealthy: (fw, exclude) => !!fw && healthy(fw, exclude).length > 0,
    fallbackEngine: (platform, stuck, tried) => {
      if (platform !== 'telegram') return null; // engine moves are keyed on Telegram topics
      return healthyEngines().find((fw) => fw !== stuck && !tried.includes(fw)) ?? null;
    },
    hints: (pane) => {
      const out: string[] = [];
      try {
        const m = classifyLoginExpired(pane);
        if (m.loginExpired) out.push(`an older login-expired wording check matched: "${(m.matchedLine ?? '').slice(0, 80)}"`);
      } catch { /* @silent-fallback-ok — a hint only; the judge decides */ }
      return out;
    },
    isProtected: input.isProtected,
    isPinned: (platform, key) => {
      if (platform !== 'telegram') return false; // no engine move outside Telegram topics: fallbackEngine is null there, so it is a plain tell
      const p = input.profileFor(Number(key));
      const by = p?.updatedBy ?? '';
      return !!p?.framework && (!by.startsWith('system:') || by.startsWith(NEVER_SILENT_RESTORED_PIN_PREFIX));
    },
    observeLoginExpired: input.observeLoginExpired,
    ...(input.inPlaceRefreshPossible ? { inPlaceRefreshPossible: input.inPlaceRefreshPossible } : {}),
    swap: input.swap,
    applyFallback: async (platform, key, target, by, text) => {
      if (platform !== 'telegram') return { ok: false, from: null, fromUpdatedBy: null, reason: 'engine moves need a Telegram topic' };
      const topicId = Number(key);
      const tmux = input.sessionForTelegramTopic(topicId);
      const before = input.profileFor(topicId);
      const from = before?.framework ?? null;
      // Record who chose the engine; a restored pin keeps its original chooser in the label.
      const rawBy = before?.updatedBy ?? null;
      const fromUpdatedBy = before?.framework && rawBy
        ? (rawBy.startsWith(NEVER_SILENT_RESTORED_PIN_PREFIX) ? rawBy.slice(NEVER_SILENT_RESTORED_PIN_PREFIX.length) : rawBy)
        : null;
      // Nothing to restart ⇒ write nothing (a profile written with no restart would be a silent half-move).
      if (!tmux) return { ok: false, from, fromUpdatedBy, reason: 'no session to restart' };
      const wrote = await input.writeFramework(topicId, target, by === 'tap' ? `${NEVER_SILENT_SYSTEM_PRINCIPAL}:tap` : NEVER_SILENT_SYSTEM_PRINCIPAL);
      if (!wrote) return { ok: false, from, fromUpdatedBy, reason: 'profile write refused' };
      let respawned = false;
      try { respawned = await input.respawnTopic(topicId, tmux, text); } catch { respawned = false; }
      if (!respawned) {
        // Undo the write so the conversation is exactly as it was (including who chose its engine).
        await input.writeFramework(topicId, from, rawBy ?? `${NEVER_SILENT_SYSTEM_PRINCIPAL}:rollback`).catch(() => false);
        return { ok: false, from, fromUpdatedBy, reason: 'restart failed; move undone' };
      }
      return { ok: true, from, fromUpdatedBy };
    },
    restoreFallback: async (platform, key, from, fromUpdatedBy) => {
      if (platform !== 'telegram') return false;
      const topicId = Number(key);
      const p = input.profileFor(topicId);
      // Only undo our own move: an operator change since then wins.
      if (!(p?.updatedBy ?? '').startsWith(NEVER_SILENT_SYSTEM_PRINCIPAL)) return true;
      // Put back what was there. An operator pin comes back under the restored-pin label (still a
      // pin for isPinned), never in the operator's own name.
      return input.writeFramework(topicId, from, from && fromUpdatedBy ? `${NEVER_SILENT_RESTORED_PIN_PREFIX}${fromUpdatedBy}` : `${NEVER_SILENT_SYSTEM_PRINCIPAL}:restore`);
    },
    sendNotice: async (platform, key, text, button) => {
      if (platform === 'telegram') {
        const newest = store.openFor(platform, key).at(-1)?.inboundMessageId ?? '';
        return input.sendTelegramNotice(Number(key), text, newest, button);
      }
      return input.sendSlackNotice(key, text);
    },
    raiseNeed: input.raiseNeed,
    clearNeed: input.clearNeed,
    repairStarted: input.repairStarted,
    // Moving back needs PROOF the login works (a passing sign-in check), never "not known to be broken":
    // during the Inspec incident the dead account read active/unavailable the whole time.
    accountHealthy: (id) => {
      const a = input.poolAccounts().find((x) => x.id === id);
      return !!a && a.status === 'active' && input.loginCheck(id) === 'ok';
    },
    log: (event) => {
      try {
        const kind = neverSilentEvidenceKind(event);
        if (kind) input.evidence?.(kind, String(event.event), { ...event });
      } catch { /* @silent-fallback-ok — evidence is a measurement, never a gate */ }
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, JSON.stringify(event) + '\n');
      } catch { /* @silent-fallback-ok — the incidents route still shows the state */ }
    },
    now,
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  return {
    store,
    watcher,
    observeLogged: (platform, key, row) => {
      if (row.fromUser) {
        watcher.onInbound(platform, key, row.messageId, row.text, row.senderName);
        return;
      }
      const text = (row.text ?? '').trim();
      if (text.startsWith('🔭')) { watcher.onStandby(platform, key); return; }
      if (row.provenance === 'automation') return; // Instar's own notices never answer
      // Any real agent message answers (no wording list decides what "counts"; §3.1 as built).
      if (isSystemOrProxyMessage(text)) return;
      watcher.onReply(platform, key);
    },
    handleTelegramTap: async (tap) => {
      const nonce = parseAskCallback(tap.data);
      if (!nonce) return 'That button is no longer active.';
      return watcher.handleAskTap(nonce, tap.fromIsOwner);
    },
    start: (intervalMs = 15_000) => {
      if (timer) return;
      const run = () => {
        if (running) return;
        running = true;
        watcher.tick().finally(() => { running = false; });
      };
      setTimeout(run, 5_000).unref?.();
      timer = setInterval(run, intervalMs);
      timer.unref?.();
    },
    stop: () => { if (timer) clearInterval(timer); timer = null; },
  };
}
