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
import fs from 'node:fs';
import path from 'node:path';
import type { SessionChannelRegistry } from '../messaging/shared/SessionChannelRegistry.js';
import type { AppConversationStore } from './AppConversationStore.js';
import { cleanConversationTitle } from './appConversationText.js';

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
}

export type AppDispatchOutcome = 'delivered' | 'refused';
export type AppInboundDispatch = (input: AppDispatchInput) => Promise<AppDispatchOutcome>;

/** The SessionManager slice the dispatch needs. */
export interface AppDispatchSessions {
  listRunningSessions(): Array<{ id: string; tmuxSession: string }>;
  waitForClaudeReady?(tmuxSession: string, timeoutMs?: number): Promise<boolean>;
  injectMessage(tmuxSession: string, text: string, opts?: { conversationId?: string }): boolean;
  killSession?(sessionId: string): boolean;
  spawnInteractiveSession(initialMessage?: string, name?: string, options?: { bootstrapConversationIds?: number[] }): Promise<string>;
}

export interface AppDispatchAdmission {
  admit(input: { sessionKey: string; callsite: 'app-inbound-spawn' }): { allow: boolean; reason: string };
}

export interface AppInboundDispatchDeps {
  sessions: AppDispatchSessions;
  channels: SessionChannelRegistry;
  store: AppConversationStore;
  stateDir: string;
  spawnAdmission?: () => AppDispatchAdmission | null | undefined;
  /** Whether the app reply relay is installed and current (spawn refused otherwise). */
  relayReady?: () => { ready: true } | { ready: false; reason: string };
  log?: (line: string) => void;
  /** Ready-wait budget for an existing session (ms). */
  readyTimeoutMs?: number;
}

const HISTORY = 30;

/** The injection tag. Title and owner name are re-cleaned here (defense in depth). */
export function appInjectionTag(alias: number, title: string, ownerName: string, verdict: AppDispatchInput['originVerdict']): string {
  const t = cleanConversationTitle(title) ?? 'Untitled';
  const o = cleanConversationTitle(ownerName) ?? 'Operator';
  return `[app:${alias} "${t}" from ${o}${verdict === 'verified' ? ' (📱 signed)' : ''}]`;
}

export function createAppInboundDispatch(deps: AppInboundDispatchDeps): AppInboundDispatch {
  const log = deps.log ?? (() => undefined);
  return async (input) => {
    const channelKey = String(input.alias);
    const tag = appInjectionTag(input.alias, input.title, input.ownerName, input.originVerdict);

    // Context: recent history from the conversation store (never a platform API).
    const history = deps.store.browseMessages(input.conversationKey, null, HISTORY).messages
      .filter((m) => m.messageId !== input.messageId);
    const lines: string[] = [];
    if (history.length > 0) {
      lines.push('CONTINUATION — You are resuming an EXISTING app conversation. Read the context below before responding. Do NOT ask what was being discussed.');
      lines.push('');
      lines.push(`--- Conversation History (last ${history.length} messages) ---`);
      for (const m of history) {
        const time = new Date(m.at).toISOString().slice(11, 19);
        lines.push(`[${time}] ${m.role === 'agent' ? 'Agent' : (cleanConversationTitle(input.ownerName) ?? 'Operator')}: ${m.text}`);
      }
      lines.push('--- End Conversation History ---');
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
    lines.push('Only relay conversational text — not tool output, file contents, or internal reasoning.');
    lines.push(`Conversation id: ${input.alias} — the durable identity of THIS app conversation on this machine. Use it as the topicId when opening durable state (e.g. POST /commitments).`);
    const contextData = lines.join('\n');
    const tmpDir = path.join(deps.stateDir, 'state', 'app-dispatch');
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const ctxPath = path.join(tmpDir, `ctx-${input.alias}-${Date.now()}.txt`);
    fs.writeFileSync(ctxPath, contextData, { mode: 0o600 }); /* state-registry: app-conversations */
    const full = `${tag} ${input.text} (IMPORTANT: Read ${ctxPath} for conversation history and app relay instructions — you MUST relay your response back.)`;
    let bootstrap = full;
    if (full.length > 500) {
      const msgPath = path.join(tmpDir, `msg-${input.alias}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`);
      fs.writeFileSync(msgPath, `${full}\n\n${contextData}`, { mode: 0o600 }); /* state-registry: app-conversations */
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
    const name = await deps.sessions.spawnInteractiveSession(bootstrap, undefined, { bootstrapConversationIds: [input.alias] });
    if (!name) return 'refused';
    deps.channels.register(channelKey, name, input.title);
    log(`[app→session] spawned ${name} for app conversation ${input.alias}`);
    return 'delivered';
  };
}
