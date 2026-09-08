import { deterministicAutomationAuthor, unknownAutomationAuthor, type OriginAutomationAuthor } from '../messaging/telegram-origin/OriginAutomationAuthor.js';
import type { TelegramOriginService } from '../messaging/telegram-origin/TelegramOriginService.js';
import type { TelegramOriginRuntime } from '../messaging/telegram-origin/TelegramOriginRuntime.js';

/** Private producer/body binding shared by the two production triage callbacks. */
export function triageOriginSender(service: TelegramOriginService | undefined,
  producerId: 'stall-triage-nurse' | 'triage-orchestrator', send: (topicId: number, text: string) => Promise<unknown>) {
  service?.registerAutomationProducer(producerId);
  return async (topicId: number, text: string, author: OriginAutomationAuthor = deterministicAutomationAuthor()) => {
    if (!service) return send(topicId, text);
    const body = { text };
    const credential = service.issueAutomationReply(producerId, topicId, body, author);
    return service.runWithAutomationReply(credential, topicId, body, () => send(topicId, text));
  };
}

/** The caller resolves a unique tmux name to an infrastructure session ID.
 * Refresh only that enrolled observer; do not infer a model from pane text,
 * topic settings, triage configuration, or another session's last call. */
export async function readTriageSessionAuthor(runtime: TelegramOriginRuntime | undefined,
  sessionId: string | undefined): Promise<OriginAutomationAuthor> {
  if (!runtime) return unknownAutomationAuthor('triage-origin-runtime-unavailable');
  if (!sessionId) return unknownAutomationAuthor('triage-session-identity-unavailable');
  const binding = runtime.sessions.getBinding(sessionId);
  if (!binding) return unknownAutomationAuthor('triage-session-not-enrolled');
  await runtime.observer.refresh(sessionId);
  const current = runtime.sessions.getBinding(sessionId), observation = runtime.observer.get(sessionId);
  if (!current || current.sessionIncarnation !== binding.sessionIncarnation ||
      !observation || observation.sessionIncarnation !== binding.sessionIncarnation || observation.harnessId !== binding.harnessId) {
    return unknownAutomationAuthor('triage-session-observer-mismatch');
  }
  const at = observation.model.observedAt ? Date.parse(observation.model.observedAt) : null;
  return {
    harness: { value: binding.harnessId, status: 'observed',
      sourceEventRef: `session:${sessionId}:${binding.sessionIncarnation}`, observedAt: Date.parse(binding.issuedAt), reason: null },
    model: { value: observation.model.value, status: observation.model.status,
      sourceEventRef: observation.model.sourceEventRef, observedAt: at !== null && Number.isFinite(at) ? at : null,
      reason: observation.model.reason ?? null },
  };
}
