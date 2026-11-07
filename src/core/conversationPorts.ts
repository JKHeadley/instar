/**
 * Per-kind ports for app and Slack conversations (docs/specs/session-swap-any-conversation.md §3.2).
 * Telegram keeps its own ports in server.ts; every function here answers null/false/no-op for a
 * numeric key, so a Telegram path never runs through this module.
 *
 * Built once at boot with late-bound lookups, so a part that isn't wired yet (no app conversations,
 * no Slack) answers "nothing here" rather than failing.
 */
import { appKeyOf, slackRoutingKeyOf } from './conversationKeys.js';

export interface Landed { framework: string | null; model: string | null }
export interface ResolvedLike { framework?: string | null; model?: string | null; modelTier?: unknown; thinkingMode?: string | null; effort?: string | null }
/** What a start is asked for: the engine and model, plus the thinking-mode and effort pins. */
export interface Want extends Landed { thinkingMode?: string | null; effort?: string | null }

export interface ConversationPortsDeps {
  /** Running sessions by tmux name. */
  runningNames(): string[];
  killByTmuxName(name: string): boolean;
  /** Profile keys whose start the orchestrator (or a restart here) has in flight. */
  inFlight: Set<string>;
  app: () => {
    sessionFor(conversationKey: string): string | null;
    isOwner(): boolean;
    /** The conversation key a running session serves, or null. */
    conversationOfSession(tmuxSession: string): string | null;
    start(conversationKey: string, want: Want): Promise<Landed | null>;
    disclose(conversationKey: string, text: string): Promise<void>;
  } | null;
  slack: () => {
    sessionFor(routingKey: string): string | null;
    routingKeyOfSession(tmuxSession: string): string | null;
    /** Start a session for the routing key (the SessionRefresh respawner); returns its tmux name or ''. */
    respawn(routingKey: string, prompt: string): Promise<string>;
    launchedOn(tmuxSession: string): Landed | null;
    send(routingKey: string, text: string): Promise<void>;
  } | null;
}

export interface ConversationPorts {
  session(profileKey: string): string | null;
  start(profileKey: string, resolved: ResolvedLike): Promise<Landed | null>;
  disclose(profileKey: string, text: string): Promise<void>;
  canDisclose(profileKey: string): boolean;
  listSessions(): Array<{ topicKey: string; sessionName: string }>;
  /** session(), kill through the tmux-name path, then start(): the legacy framework write's restart. */
  restart(profileKey: string, resolved: ResolvedLike): Promise<{ respawned: boolean; error?: string }>;
}

export const SLACK_RESTART_PROMPT = 'Your session restarted on a new engine. There is no new message; continue where you left off when the next one arrives.';

export function createConversationPorts(deps: ConversationPortsDeps): ConversationPorts {
  const running = (name: string | null): string | null => (name && deps.runningNames().includes(name) ? name : null);
  const ports: ConversationPorts = {
    session: (profileKey) => {
      const app = appKeyOf(profileKey);
      if (app) return running(deps.app()?.sessionFor(app) ?? null);
      const slack = slackRoutingKeyOf(profileKey);
      if (slack) return running(deps.slack()?.sessionFor(slack) ?? null);
      return null;
    },
    start: async (profileKey, resolved) => {
      const want: Want = {
        framework: resolved.framework ?? null,
        model: resolved.modelTier ? null : (resolved.model ?? null),
        thinkingMode: resolved.thinkingMode ?? null,
        effort: resolved.effort ?? null,
      };
      const app = appKeyOf(profileKey);
      if (app) { const a = deps.app(); return a ? a.start(app, want) : null; }
      const slack = slackRoutingKeyOf(profileKey);
      const sl = slack ? deps.slack() : null;
      if (slack && sl) {
        const name = await sl.respawn(slack, SLACK_RESTART_PROMPT);
        return name ? sl.launchedOn(name) : null;
      }
      return null;
    },
    disclose: async (profileKey, text) => {
      const app = appKeyOf(profileKey);
      const a = app ? deps.app() : null;
      if (app && a) { if (a.isOwner()) await a.disclose(app, text); return; }
      const slack = slackRoutingKeyOf(profileKey);
      const sl = slack ? deps.slack() : null;
      if (slack && sl) await sl.send(slack, text);
    },
    canDisclose: (profileKey) => {
      if (appKeyOf(profileKey)) return deps.app()?.isOwner() === true;
      if (slackRoutingKeyOf(profileKey)) return deps.slack() !== null;
      return false;
    },
    listSessions: () => {
      const out: Array<{ topicKey: string; sessionName: string }> = [];
      const a = deps.app();
      const sl = deps.slack();
      for (const name of deps.runningNames()) {
        try {
          const key = a?.conversationOfSession(name) ?? null;
          if (key) { out.push({ topicKey: `app:${key}`, sessionName: name }); continue; }
          const rk = sl?.routingKeyOfSession(name) ?? null;
          if (rk) out.push({ topicKey: `slack:${rk}`, sessionName: name });
        } catch { /* @silent-fallback-ok — an unreadable mapping leaves that session out of the sweep, as before this change */ }
      }
      return out;
    },
    restart: async (profileKey, resolved) => {
      const name = ports.session(profileKey);
      if (!name) return { respawned: false };
      if (!deps.killByTmuxName(name)) return { respawned: false, error: 'the old session did not stop' };
      deps.inFlight.add(profileKey);
      try {
        const landed = await ports.start(profileKey, resolved);
        return landed ? { respawned: true } : { respawned: false, error: 'the new session was not started' };
      } catch (err) {
        return { respawned: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        deps.inFlight.delete(profileKey);
      }
    },
  };
  return ports;
}

/** The Slack resume record the two views share (SlackAdapter's guarded record). */
export interface SlackResumeRecord {
  peek(routingKey: string): { uuid: string; framework: string | null; provenance: 'hook' | 'mtime' | null } | null;
  park(routingKey: string, reason: string): void;
  unpark(routingKey: string): boolean;
}

/**
 * The orchestrator's two resume views for app and Slack keys (spec §3.1), over Slack's one record.
 * `forKey` answers null for a Telegram key: the caller then uses the Telegram ports unchanged.
 */
export function conversationResumeViews(slack: () => SlackResumeRecord | null) {
  const s = (topicKey: string) => { const rk = slackRoutingKeyOf(topicKey); const r = rk ? slack() : null; return rk && r ? { rk, r } : null; };
  const isConversation = (topicKey: string) => appKeyOf(topicKey) !== null || slackRoutingKeyOf(topicKey) !== null;
  return {
    /** True when this key is an app or Slack conversation (the views below decide it). */
    handles: isConversation,
    claude: {
      ready: (k: string) => { const x = s(k); const p = x?.r.peek(x.rk); return !!p && p.framework === 'claude-code' && p.provenance === 'hook'; },
      resumeId: (k: string) => { const x = s(k); const p = x?.r.peek(x.rk); return p && p.framework === 'claude-code' ? p.uuid : null; },
      park: (k: string, reason: string) => { const x = s(k); x?.r.park(x.rk, reason); },
      unpark: (k: string) => { const x = s(k); return x ? x.r.unpark(x.rk) : false; },
    },
    codex: {
      get: (k: string) => { const x = s(k); const p = x?.r.peek(x.rk); return p && p.framework === 'codex-cli' ? p.uuid : null; },
      captureAtKill: async () => ({ outcome: 'none' as const, candidateCount: 0 }),
      park: (k: string, reason: string) => { const x = s(k); x?.r.park(x.rk, reason); },
      unpark: (k: string) => { const x = s(k); return x ? x.r.unpark(x.rk) : false; },
    },
  };
}
