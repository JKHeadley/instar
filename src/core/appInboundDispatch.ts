/**
 * appInboundDispatch — hand an app message to its conversation's session
 * (docs/specs/mobile-native-conversations.md §4.2 step 5).
 *
 * Mirrors slackInboundDispatch, but exists on an agent with no Slack and no Telegram: the
 * conversation's session is found in a SessionChannelRegistry keyed by the local alias; a live,
 * ready session gets the message injected; otherwise the spawn is admitted through SpawnAdmission
 * and a session is spawned with `INSTAR_CONVERSATION_ID=<alias>` and a bind token scoped to it
 * (`bootstrapConversationIds: [alias]`). Context history comes from the conversation store.
 *
 * The tag is `[app:<alias> "<title>" from <owner name>]`. The title and owner name are cleaned
 * exactly as Slack sender names are and sit inside quotes in a fixed position. "📱 signed" is
 * appended by the server only on a `verified` origin verdict (increment 2); increment 1 never
 * appends it.
 */
import { safeInboxTarget } from './memorySessionPolicy.js';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionChannelRegistry } from '../messaging/shared/SessionChannelRegistry.js';
import type { AppConversationStore } from './AppConversationStore.js';
import { cleanConversationTitle } from './appConversationText.js';
import { historyLine } from './appMediaTypes.js';

export interface AppDispatchInput {
  conversationKey: string;
  alias: number;
  title: string;
  /** The text as delivered (authority tokens already removed). */
  text: string;
  messageId: string;
  ownerName: string;
  /** The origin verdict; increment 1 always passes 'unknown' (never 'verified'). */
  originVerdict: 'verified' | 'redacted' | 'failed' | 'unknown' | 'none';
  /**
   * Lines the session missed (media spec §4.12): files that finished copying after an earlier
   * delivery with no live session to tell, and files that could not be copied within 7 days.
   */
  notes?: string[];
  /** Memory privacy: the phone's person, `null` for the owner's own phone. */
  memoryPersonId?: string | null;
}

export type AppDispatchOutcome = 'delivered' | 'refused';
export type AppInboundDispatch = (input: AppDispatchInput) => Promise<AppDispatchOutcome>;

/** The SessionManager slice the dispatch needs. */
export interface AppDispatchSessions {
  listRunningSessions(): Array<{ id: string; tmuxSession: string }>;
  waitForClaudeReady?(tmuxSession: string, timeoutMs?: number): Promise<boolean>;
  injectMessage(tmuxSession: string, text: string, opts?: { conversationId?: string }): boolean;
  killSession?(sessionId: string): boolean;
  spawnInteractiveSession(initialMessage?: string, name?: string, options?: { memoryPlaceKey?: string; bootstrapConversationIds?: number[]; framework?: string; defaultModel?: string; thinkingMode?: string; effort?: string; triggeredBy?: string }): Promise<string>;
}

export interface AppDispatchAdmission {
  admit(input: { sessionKey: string; callsite: 'app-inbound-spawn' | 'app-respawn' | 'app-new-session' }): { allow: boolean; reason: string };
}

/** The engine and model a conversation is set to (session-swap-any-conversation §3.1); null fields mean the agent default. */
export interface AppProfile {
  framework: string | null;
  model: string | null;
  /** The conversation's thinking-mode and effort pins, as the Telegram and Slack spawns pass them. */
  thinkingMode?: string | null;
  effort?: string | null;
}

export interface AppInboundDispatchDeps {
  sessions: AppDispatchSessions;
  channels: SessionChannelRegistry;
  store: AppConversationStore;
  stateDir: string;
  /** The owner's display name, for history lines stored before senders were recorded. */
  ownerDisplayName?: () => string;
  /** The inbox of a confined conversation's scope folder, or null (team-roles-and-access §4.1). */
  confinedInbox?: (conversationKey: string) => string | null;
  spawnAdmission?: () => AppDispatchAdmission | null | undefined;
  /** Whether the app reply relay is installed and current (spawn refused otherwise). */
  relayReady?: () => { ready: true } | { ready: false; reason: string };
  log?: (line: string) => void;
  /** Ready-wait budget for an existing session (ms). */
  readyTimeoutMs?: number;
  /** Memory privacy: runs before routing. False means this message was refused. */
  memoryInbound?: (input: AppDispatchInput) => Promise<boolean>;
  /** The conversation's engine and model (its `app:<key>` profile). Absent ⇒ the agent default. */
  profile?: (conversationKey: string) => AppProfile | null;
  /** True while the profile orchestrator is starting this conversation's session (a switch under way). */
  startInFlight?: (profileKey: string) => boolean;
  /** Tell the profile orchestrator a spawn landed, with what it launched on (its `recordSpawnSuccess`). */
  spawned?: (profileKey: string, applied: AppProfile) => void;
  /** What a running session launched on (its record), for reporting what a start actually landed on. */
  launchedOn?: (tmuxSession: string) => AppProfile | null;
  /** How long a new message waits for a switch under way before dispatching anyway (ms). */
  startWaitMs?: number;
}

/**
 * One start at a time per conversation (review finding): the inbound spawn and the message-free
 * start share this lock through their deps object, and each re-checks for a live session inside it,
 * so a message spawning during a switch and the switch's own start can't both launch a session.
 */
const startLocks = new WeakMap<AppInboundDispatchDeps, Map<string, Promise<unknown>>>();
async function withStartLock<T>(deps: AppInboundDispatchDeps, conversationKey: string, fn: () => Promise<T>): Promise<T> {
  let locks = startLocks.get(deps);
  if (!locks) { locks = new Map(); startLocks.set(deps, locks); }
  const prev = locks.get(conversationKey) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(conversationKey, tail);
  try { return await run; } finally { if (locks.get(conversationKey) === tail) locks.delete(conversationKey); }
}

/** The conversation's live session (registered and running), or null. */
function liveSession(deps: AppInboundDispatchDeps, alias: number): string | null {
  const name = deps.channels.getSessionForChannel(String(alias));
  return name && deps.sessions.listRunningSessions().some((x) => x.tmuxSession === name) ? name : null;
}

/** Wait for a switch under way to finish, so a message never starts a second session beside it. */
async function waitForStart(deps: AppInboundDispatchDeps, profileKey: string): Promise<void> {
  if (!deps.startInFlight) return;
  const until = Date.now() + (deps.startWaitMs ?? 60_000);
  while (deps.startInFlight(profileKey) && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
}

/** The spawn options carrying the conversation's engine and model. */
function engineOptions(deps: AppInboundDispatchDeps, conversationKey: string): SpawnEngine {
  let p: AppProfile | null = null;
  try { p = deps.profile?.(conversationKey) ?? null; } catch { /* @silent-fallback-ok — an unreadable profile starts on the agent default, as before this change */ p = null; }
  return toSpawnOptions(p);
}

type SpawnEngine = { framework?: string; defaultModel?: string; thinkingMode?: string; effort?: string };

/** A profile as spawn options (the session manager's names: `framework`, `defaultModel`, `thinkingMode`, `effort`). */
function toSpawnOptions(p: AppProfile | null): SpawnEngine {
  return {
    ...(p?.framework ? { framework: p.framework } : {}),
    ...(p?.model ? { defaultModel: p.model } : {}),
    ...(p?.thinkingMode ? { thinkingMode: p.thinkingMode } : {}),
    ...(p?.effort ? { effort: p.effort } : {}),
  };
}

const HISTORY = 30;

/** The injection tag. Title and owner name are re-cleaned here (defense in depth). */
export function appInjectionTag(alias: number, title: string, ownerName: string, verdict: AppDispatchInput['originVerdict']): string {
  const t = cleanConversationTitle(title) ?? 'Untitled';
  const o = cleanConversationTitle(ownerName) ?? 'Operator';
  return `[app:${alias} "${t}" from ${o}${verdict === 'verified' ? ' (📱 signed)' : ''}]`;
}

/**
 * One line into the conversation's LIVE session, never a spawn (the "now available" follow-up of
 * media spec §4.12). False when no live session serves the conversation; the line then waits for
 * the next delivery's context.
 */
export function createAppFollowUpInjector(deps: { sessions: Pick<AppDispatchSessions, 'listRunningSessions' | 'injectMessage'>; channels: SessionChannelRegistry }): (alias: number, line: string) => boolean {
  return (alias, line) => {
    const name = deps.channels.getSessionForChannel(String(alias));
    if (!name || !deps.sessions.listRunningSessions().some((s) => s.tmuxSession === name)) return false;
    try { return deps.sessions.injectMessage(name, line, { conversationId: String(alias) }); } catch { return false; } // @silent-fallback-ok — false keeps the line for the next delivery
  };
}

/** The session context: recent history and the relay instructions, written to a private file. */
function writeContext(deps: AppInboundDispatchDeps, input: Pick<AppDispatchInput, 'conversationKey' | 'alias' | 'ownerName' | 'notes'> & { messageId: string | null }): { ctxPath: string; contextData: string; fileFor: (name: string) => string } {
    // Context: recent history from the conversation store (never a platform API).
    const history = deps.store.browseMessages(input.conversationKey, null, HISTORY).messages
      .filter((m) => m.messageId !== input.messageId);
    const lines: string[] = [];
    if (input.notes && input.notes.length > 0) {
      lines.push('--- Files from earlier messages ---');
      for (const n of input.notes) lines.push(n);
      lines.push('---');
      lines.push('');
    }
    if (history.length > 0) {
      lines.push('CONTINUATION — You are resuming an EXISTING app conversation. Read the context below before responding. Do NOT ask what was being discussed.');
      lines.push('');
      lines.push(`--- Conversation History (last ${history.length} messages) ---`);
      for (const m of history) {
        const time = new Date(m.at).toISOString().slice(11, 19);
        // A shared conversation has several speakers: each line names the one stored with it.
        const who = m.role === 'agent' ? 'Agent' : (cleanConversationTitle(m.senderName ?? deps.ownerDisplayName?.() ?? input.ownerName) ?? 'Operator');
        // Lazy on purpose (media spec §4.5): earlier files are named, never copied or pulled here.
        for (const a of m.attachments ?? []) lines.push(`[${time}] ${who}: ${historyLine(a)}`);
        if (m.text || !m.attachments) lines.push(`[${time}] ${who}: ${m.text}`);
      }
      lines.push('--- End Conversation History ---');
      if (history.some((m) => m.attachments)) lines.push('To open an earlier file, run: .instar/scripts/app-media-path <attachment id>');
      lines.push('');
    }
    lines.push('CRITICAL: You MUST relay your response back to the app after responding.');
    lines.push('Use the relay script (write ONLY your reply text):');
    lines.push('');
    lines.push("cat <<'EOF' | .instar/scripts/app-reply.sh");
    lines.push('Your response text here');
    lines.push('EOF');
    lines.push('');
    lines.push('Strip the [app:] prefix before interpreting the message.');
    const confinedInbox = deps.confinedInbox?.(input.conversationKey) ?? null;
    // Sending a file is refused from a confined session, so its context does not offer it.
    if (!confinedInbox) lines.push('To send files, add --file <path> before the text (repeat it for several); the text can be an argument or piped in as usual.');
    lines.push('Only relay conversational text and the files you mean to send — not tool output or internal reasoning.');
    lines.push(`Conversation id: ${input.alias} — the durable identity of THIS app conversation on this machine. Use it as the topicId when opening durable state (e.g. POST /commitments).`);
    const contextData = lines.join('\n');
    const tmpDir = confinedInbox ?? path.join(deps.stateDir, 'state', 'app-dispatch');
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    // A confined session can write to its inbox, so a file for it goes through the safe path.
    const fileFor = (name: string) => (confinedInbox ? safeInboxTarget(confinedInbox, name) : path.join(tmpDir, name));
    // Exclusive write, so two starts in one millisecond need different names.
    const ctxPath = fileFor(`ctx-${input.alias}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`);
    fs.writeFileSync(ctxPath, contextData, { mode: 0o600, flag: 'wx' }); /* state-registry: app-conversations */
    return { ctxPath, contextData, fileFor };
}

export function createAppInboundDispatch(deps: AppInboundDispatchDeps): AppInboundDispatch {
  const log = deps.log ?? (() => undefined);
  return async (input) => {
    if (deps.memoryInbound && !(await deps.memoryInbound(input))) {
      log('[app→session] refused: this conversation needs private memory, which is not available here');
      return 'refused';
    }
    // A switch under way restarts this conversation's session: wait for it rather than start a
    // second one beside it (spec §3.1). If it was refused, this message starts the session below.
    await waitForStart(deps, `app:${input.conversationKey}`);
    const channelKey = String(input.alias);
    const tag = appInjectionTag(input.alias, input.title, input.ownerName, input.originVerdict);
    const { ctxPath, contextData, fileFor } = writeContext(deps, input);
    const full = `${tag} ${input.text} (IMPORTANT: Read ${ctxPath} for conversation history and app relay instructions — you MUST relay your response back.)`;
    let bootstrap = full;
    if (full.length > 500) {
      const msgPath = fileFor(`msg-${input.alias}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`);
      fs.writeFileSync(msgPath, `${full}\n\n${contextData}`, { mode: 0o600, flag: 'wx' }); /* state-registry: app-conversations */
      bootstrap = `${tag} [Long message saved to ${msgPath} — read it to see the full message and conversation history]`;
    }

    // An existing live session: inject when ready.
    const existing = deps.channels.getSessionForChannel(channelKey);
    if (existing) {
      const alive = deps.sessions.listRunningSessions().find((s) => s.tmuxSession === existing);
      if (alive) {
        const ready = deps.sessions.waitForClaudeReady ? await deps.sessions.waitForClaudeReady(existing, deps.readyTimeoutMs ?? 15_000) : true;
        if (ready) {
          const ok = deps.sessions.injectMessage(existing, bootstrap, { conversationId: String(input.alias) });
          if (ok) { log(`[app→session] injected into ${existing}`); return 'delivered'; }
        }
        // Stuck or the inject failed: replace the session rather than lose the message.
        try { deps.sessions.killSession?.(alive.id); } catch { /* @silent-fallback-ok — a dead session is respawned below */ }
      }
    }

    const relay = deps.relayReady?.() ?? { ready: true as const };
    if (!relay.ready) {
      log(`[app→session] spawn refused: app reply relay not ready (${relay.reason})`);
      return 'refused';
    }
    const admission = deps.spawnAdmission?.();
    if (admission) {
      try {
        const d = admission.admit({ sessionKey: `app:${input.conversationKey}`, callsite: 'app-inbound-spawn' });
        if (!d.allow) { log(`[app→session] spawn refused by admission: ${d.reason}`); return 'refused'; }
      } catch (err) { // @silent-fallback-ok — admission errors fail open toward reachability, as the Slack callsite does
        log(`[app→session] admission error (fail-open): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return withStartLock(deps, input.conversationKey, async () => {
      // A start that finished while this message waited: hand the message to that session.
      const started = liveSession(deps, input.alias);
      if (started) {
        const ready = deps.sessions.waitForClaudeReady ? await deps.sessions.waitForClaudeReady(started, deps.readyTimeoutMs ?? 15_000) : true;
        if (ready && deps.sessions.injectMessage(started, bootstrap, { conversationId: String(input.alias) })) {
          log(`[app→session] injected into ${started} (started while this message waited)`);
          return 'delivered' as const;
        }
      }
      const engine = engineOptions(deps, input.conversationKey);
      const name = await deps.sessions.spawnInteractiveSession(bootstrap, undefined, { bootstrapConversationIds: [input.alias], memoryPlaceKey: `app:${input.conversationKey}`, ...engine });
      if (!name) return 'refused' as const;
      deps.channels.register(channelKey, name, input.title);
      reportSpawned(deps, input.conversationKey, name, engine);
      log(`[app→session] spawned ${name} for app conversation ${input.alias}`);
      return 'delivered' as const;
    });
  };
}

/** Tell the orchestrator what landed, except while its own start is under way (it records that one). */
function reportSpawned(deps: AppInboundDispatchDeps, conversationKey: string, tmuxSession: string, engine: SpawnEngine): AppProfile {
  const applied = deps.launchedOn?.(tmuxSession) ?? { framework: engine.framework ?? null, model: engine.defaultModel ?? null };
  const key = `app:${conversationKey}`;
  if (!deps.startInFlight?.(key)) {
    try { deps.spawned?.(key, applied); } catch { /* @silent-fallback-ok — bookkeeping only; the session is running */ }
  }
  return applied;
}

/** What `startApp` needs beyond the dispatch's own deps. */
export interface AppStartDeps {
  /** True when this machine serves the conversation (app-conversations-in-the-pool §2.1). */
  serves: (conversationKey: string) => boolean;
  /** The conversation's local alias, or null when it has none here. */
  aliasFor: (conversationKey: string) => number | null;
  /** The conversation's title (null when it is gone). */
  titleFor: (conversationKey: string) => string | null;
  ownerName: () => string;
  /**
   * Memory privacy: record the conversation's place exactly as its inbound messages do, and say
   * whether a session may serve it (false: private memory isn't available for it here). Absent ⇒
   * allowed. Without it, a session started before the first message would run in the wrong memory
   * scope and be retired by that first message (session-conversation-for-every-session §2.1 step 5).
   */
  memoryPlace?: (conversationKey: string) => Promise<boolean>;
  /** Told why a start started nothing (for the create answer's words). */
  onRefused?: (conversationKey: string, refusal: AppStartRefusal) => void;
}

/**
 * Why a session is started with no message: an engine switch restarting the conversation's session
 * (part 1), or a new session someone created with this conversation (part 2,
 * docs/specs/session-conversation-for-every-session.md §2.1).
 */
export type AppStartReason = 'engine-switch' | 'new';

/** Why a start started nothing. */
export type AppStartRefusal = 'not-served' | 'gone' | 'other-session' | 'relay' | 'admission' | 'memory' | 'spawn-failed';

/**
 * A start's options beyond the profile: why. Never a session name: `SessionManager` reuses a running
 * session whose name matches, and one session would then serve two conversations (part 2 §2.1).
 */
export interface AppStartOptions { reason?: AppStartReason }

/**
 * Start an app conversation's session with no new message. After an engine switch the orchestrator
 * kills the old session and calls this (part 1 §3.3); a New session with an app conversation calls it
 * once the conversation exists (part 2 §2.1). It answers what the session landed on, or null when
 * nothing was started, telling `onRefused` why.
 */
export function createAppSessionStarter(deps: AppInboundDispatchDeps, start: AppStartDeps): (conversationKey: string, resolved: AppProfile, opts?: AppStartOptions) => Promise<AppProfile | null> {
  const log = deps.log ?? (() => undefined);
  const refuse = (key: string, why: AppStartRefusal, line: string): null => {
    log(`[app→session] start for ${key} refused: ${line}`);
    try { start.onRefused?.(key, why); } catch { /* @silent-fallback-ok — words only */ }
    return null;
  };
  return async (conversationKey, resolved, opts) => {
    if (!start.serves(conversationKey)) return refuse(conversationKey, 'not-served', 'not served on this machine');
    const alias = start.aliasFor(conversationKey);
    const title = start.titleFor(conversationKey);
    if (alias === null || title === null) return refuse(conversationKey, 'gone', 'the conversation is gone');
    return withStartLock(deps, conversationKey, () => startLocked(conversationKey, alias, title, resolved, opts?.reason ?? 'engine-switch'));
  };
  async function startLocked(conversationKey: string, alias: number, title: string, resolved: AppProfile, reason: AppStartReason): Promise<AppProfile | null> {
    const channelKey = String(alias);
    const live = liveSession(deps, alias);
    if (live) {
      // A message that arrived in the kill window may already have started it on the new profile.
      const on = deps.launchedOn?.(live) ?? null;
      const same = !!on && (on.framework ?? null) === (resolved.framework ?? null) && (resolved.model == null || on.model === resolved.model);
      return same ? on : refuse(conversationKey, 'other-session', 'a session on another profile is already running');
    }
    const relay = deps.relayReady?.() ?? { ready: true as const };
    if (!relay.ready) return refuse(conversationKey, 'relay', `app reply relay not ready (${relay.reason})`);
    if (start.memoryPlace) {
      let may = false;
      try { may = await start.memoryPlace(conversationKey); } catch { may = false; } // @silent-fallback-ok — refused below: an unreadable memory rule never starts an unscoped session
      if (!may) return refuse(conversationKey, 'memory', 'this conversation needs private memory, which isn\'t available here');
    }
    const admission = deps.spawnAdmission?.();
    if (admission) {
      try {
        const d = admission.admit({ sessionKey: `app:${conversationKey}`, callsite: reason === 'new' ? 'app-new-session' : 'app-respawn' });
        if (!d.allow) return refuse(conversationKey, 'admission', `admission: ${d.reason}`);
      } catch (err) { // @silent-fallback-ok — admission errors fail open toward reachability, as the inbound spawn does
        log(`[app→session] admission error (fail-open): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const ownerName = start.ownerName();
    const { ctxPath } = writeContext(deps, { conversationKey, alias, ownerName, messageId: null });
    const tag = appInjectionTag(alias, title, ownerName, 'none');
    const opening = reason === 'new'
      ? `This session was just started for a new app conversation, "${cleanConversationTitle(title) ?? 'Untitled'}". There is no message yet.`
      : 'Your session restarted on a new engine. There is no new message to answer.';
    const bootstrap = `${tag} [${opening} Read ${ctxPath} for the conversation so far and the app relay instructions, then wait for the next message.]`;
    const engine = toSpawnOptions(resolved);
    const name = await deps.sessions.spawnInteractiveSession(bootstrap, undefined, {
      bootstrapConversationIds: [alias], memoryPlaceKey: `app:${conversationKey}`, ...engine,
      // A session someone started from New session is theirs, as the dashboard's other creates are.
      ...(reason === 'new' ? { triggeredBy: 'dashboard-operator' } : {}),
    });
    if (!name) return refuse(conversationKey, 'spawn-failed', 'the session did not start');
    deps.channels.register(channelKey, name, title);
    log(`[app→session] started ${name} for app conversation ${alias} on ${resolved.framework ?? 'the agent default'}`);
    // A new session is no orchestrator start: record what it launched on, as an inbound spawn does.
    if (reason === 'new') return reportSpawned(deps, conversationKey, name, engine);
    return deps.launchedOn?.(name) ?? { framework: resolved.framework ?? null, model: resolved.model ?? null };
  }
}
