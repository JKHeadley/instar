/** Read-only preference identity projection; display aliases never become global keys. */
import { canonicalPreferenceRef } from '../core/ConversationPreferences.js';
import { inboundTopicId, toWireParams, type TopicSpaceConfig } from '../messaging/telegramTopicSpace.js';
import type { ConversationRegistry } from '../core/ConversationRegistry.js';
import type { PreferenceIdentityView } from './conversationPreferenceView.js';
export interface PreferenceIdentityDeps {
  machineId: string;
  registry?: Pick<ConversationRegistry, 'resolve' | 'resolveByKey'> | null;
  registryVersion: string;
  telegram: TopicSpaceConfig;
  topicIds: ReadonlySet<number>;
  slackIds: ReadonlySet<number>;
  appExists: (key: string) => boolean;
}
export function conversationPreferenceIdentity(deps: PreferenceIdentityDeps): PreferenceIdentityView {
  const normChat = (raw: unknown): string | null => {
    if ((typeof raw !== 'string' && typeof raw !== 'number') || !/^-?\d+$/.test(String(raw))) return null;
    const n = Number(raw); return Number.isSafeInteger(n) && n !== 0 ? String(n) : null;
  };
  const telegram = { mainChatId: normChat(deps.telegram.mainChatId), issuesChatId: normChat(deps.telegram.issuesChatId) };
  const foreign = (machine: unknown) => typeof machine === 'string' && machine !== deps.machineId;
  return {
    version: JSON.stringify([deps.registryVersion, telegram, [...deps.topicIds].sort((a,b)=>a-b), [...deps.slackIds].sort((a,b)=>a-b)]),
    resolve(raw, row) {
      const canonical = canonicalPreferenceRef(raw);
      if (canonical?.startsWith('app:')) return deps.appExists(canonical.slice(4)) ? { ref: canonical, accessRef: canonical.slice(4) } : null;
      const namespaced = canonical && /^telegram:(-?[1-9]\d*):([1-9]\d*)$/.exec(canonical);
      if (namespaced) {
        const chat = namespaced[1]!;
        if (chat !== telegram.mainChatId && chat !== telegram.issuesChatId) return null;
        const thread = Number(namespaced[2]);
        if (!Number.isSafeInteger(thread)) return null;
        const internal = inboundTopicId(chat, thread, telegram);
        try {
          const wire = toWireParams({ chat_id: telegram.mainChatId, message_thread_id: internal }, telegram);
          if (String(wire.chat_id) !== chat || wire.message_thread_id !== thread) return null;
        } catch { return null; /* @silent-fallback-ok: unverifiable wire namespaces never become preference identities. */ }
        return deps.topicIds.has(internal) ? { ref: canonical!, accessRef: `telegram:${internal}` } : null;
      }
      const bareTopic = /^telegram:([1-9]\d*)$/.exec(raw);
      if (bareTopic) {
        if (foreign(row?.machine)) return null;
        const internal = Number(bareTopic[1]);
        if (!Number.isSafeInteger(internal) || !deps.topicIds.has(internal) || !telegram.mainChatId) return null;
        try {
          const wire = toWireParams({ chat_id: telegram.mainChatId, message_thread_id: internal }, telegram);
          const ref = canonicalPreferenceRef(`telegram:${wire.chat_id}:${wire.message_thread_id}`);
          return ref ? { ref, accessRef: `telegram:${internal}` } : null;
        } catch { return null; /* @silent-fallback-ok: missing issue namespace remains unverifiable, never mapped to the main forum. */ }
      }
      const alias = /^slack:([^:]+):(-[1-9]\d*)$/.exec(raw);
      if (alias) {
        if (alias[1] !== deps.machineId || foreign(row?.machine)) return null;
        const resolved = deps.registry?.resolve(Number(alias[2]));
        return resolved?.platform === 'slack' && deps.slackIds.has(resolved.id) && canonicalPreferenceRef(resolved.key)
          ? { ref: resolved.key, accessRef: `slack:${deps.machineId}:${resolved.id}` } : null;
      }
      if (canonical?.startsWith('slack:')) {
        const resolved = deps.registry?.resolveByKey(canonical);
        return resolved?.platform === 'slack' && deps.slackIds.has(resolved.id)
          ? { ref: resolved.key, accessRef: `slack:${deps.machineId}:${resolved.id}` } : null;
      }
      return null;
    },
  };
}
