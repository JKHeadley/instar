/**
 * The ONE per-event side-effect function shared by `POST /hooks/events` (the
 * script reporter, Codex) and `POST /hooks/native-events` (Claude Code native
 * HTTP hooks) — docs/specs/native-hook-events.md D1/D2.
 *
 * It receives only the event to store (for the native route: the PROJECTED
 * event, never the raw body) and the instar session id as a parameter
 * (`req.query.instar_sid` on the old route, the `X-Instar-Session-Id` header
 * on the native one), so the session-id bridge keeps working on both.
 *
 * Every consumer this dispatch feeds is listed in the spec's D2 table; a unit
 * test scans the `case` labels of the switch below against that table's
 * fixture, so adding one without a reviewed row fails CI.
 */

import type { HookEventPayload } from '../monitoring/HookEventReceiver.js';

export interface HookEventDispatchDeps {
  receive: (payload: HookEventPayload) => boolean;
  /** Reflection metrics: one tool call. */
  recordToolCall?: () => void;
  /** jev-circles shadow (log-only). */
  observeToolAction?: (input: { sessionId: unknown; transcriptPath: unknown }) => void;
  /** Homeostasis commit counter (signal-only). */
  recordCommit?: () => void;
  /** Scope-accretion advisory ledger (Write/Edit attribution). */
  recordAdvisoryArtifact?: (input: { filePath: string; toolName: string; sessionId: string }) => void;
  sessionManager?: {
    getSessionById(id: string): { claudeSessionId?: string } | undefined;
    setClaudeSessionId(instarSessionId: string, claudeSessionId: string): void;
  } | null;
  subagentTracker?: {
    onStart(agentId: string, agentType: string, sessionId: string, opts?: { instarSessionId?: string | null }): void;
    onStop(agentId: string, sessionId: string, lastMessage?: string, transcriptPath?: string): void;
    onSessionEnd(sessionId: string, instarSessionId: string | null | undefined): number;
  } | null;
}

/** Commit test the old route has always applied to a STRING tool_input. */
const LEGACY_COMMIT_RE = /git\s+commit\b/;

/**
 * Whether a stored event reports a `git commit`. The native projection
 * computes the boolean at projection time (the raw command is never stored);
 * a legacy caller that sends a string tool_input keeps its old behaviour.
 */
export function eventIsGitCommit(payload: HookEventPayload): boolean {
  if (payload.is_git_commit === true) return true;
  const toolInput = payload.tool_input ?? (payload as Record<string, unknown>).toolInput;
  return typeof toolInput === 'string' && LEGACY_COMMIT_RE.test(toolInput);
}

/**
 * Store one event and run its side effects. Returns false when storage failed
 * (side effects are then skipped, as on the old route).
 */
export function dispatchHookEvent(deps: HookEventDispatchDeps, payload: HookEventPayload, instarSid: string): boolean {
  const stored = deps.receive(payload);
  if (!stored) return false;

  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';

  switch (payload.event) {
    case 'PostToolUse': {
      // Track tool calls for reflection metrics
      deps.recordToolCall?.();
      // jev-circles-shadow: log-only "going in circles" measurement.
      deps.observeToolAction?.({ sessionId: payload.session_id, transcriptPath: payload.transcript_path });
      // Track commits for homeostasis (work-velocity awareness). Signal-only.
      const toolName = (payload.tool_name || (payload as Record<string, unknown>).toolName || '') as string;
      if (toolName === 'Bash' && eventIsGitCommit(payload)) deps.recordCommit?.();
      // Scope-accretion ADVISORY tool-event ledger (R18).
      const filePath = typeof payload.file_path === 'string' ? payload.file_path : '';
      if (filePath && sessionId && (toolName === 'Write' || toolName === 'Edit')) {
        deps.recordAdvisoryArtifact?.({ filePath, toolName, sessionId });
      }
      break;
    }
    case 'SubagentStart': {
      const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : '';
      const agentType = typeof payload.agent_type === 'string' ? payload.agent_type : '';
      if (deps.subagentTracker && sessionId && agentId && agentType) {
        deps.subagentTracker.onStart(agentId, agentType, sessionId, { instarSessionId: instarSid || null });
      }
      break;
    }
    case 'SubagentStop': {
      const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : '';
      if (deps.subagentTracker && sessionId && agentId) {
        deps.subagentTracker.onStop(
          agentId,
          sessionId,
          typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : undefined,
          typeof payload.agent_transcript_path === 'string' ? payload.agent_transcript_path : undefined,
        );
      }
      break;
    }
    case 'SessionEnd': {
      // Clears only THIS incarnation's subagents.
      if (deps.subagentTracker && sessionId) deps.subagentTracker.onSessionEnd(sessionId, instarSid || null);
      break;
    }
    default:
      break;
  }

  // Bridge instar session ID ↔ Claude Code session ID (last-writer-wins —
  // see SessionManager.setClaudeSessionId). Every hook event carries the MAIN
  // conversation's session_id; missing/empty = malformed or custom — skip.
  if (instarSid && sessionId && deps.sessionManager) {
    const session = deps.sessionManager.getSessionById(instarSid);
    if (session && session.claudeSessionId !== sessionId) {
      deps.sessionManager.setClaudeSessionId(instarSid, sessionId);
    }
  }

  return true;
}
