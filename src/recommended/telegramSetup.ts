/**
 * What the Telegram recipe needs from this agent's config and from Telegram (docs/specs/recommended-services.md,
 * catalog row telegram): whether a Telegram entry is configured, whether its bot and group answer, and a way to
 * write or disable the entry for this agent. The bot itself is created by the setup session in the person's own
 * Telegram (BotFather), signed in with the person's own code; nothing here talks to BotFather.
 *
 * Nothing here logs a token. A bot token is a secret; a chat id is not.
 */
import { setTimeout as sleep } from 'node:timers/promises';

export interface TelegramEntry {
  token: string;
  chatId: string;
  enabled: boolean;
}

export type TelegramProbe = 'ok' | 'token-refused' | 'chat-unreachable' | 'not-forum' | 'unknown';

export interface TelegramSetupSurface {
  /** This agent's Telegram messaging entry, or null when none is configured. */
  configured(): TelegramEntry | null;
  /** One live, read-only check: the bot answers `getMe`, and the group answers `getChat` as a forum. */
  probe(token: string, chatId: string): Promise<TelegramProbe>;
  /** Writes (or replaces) this agent's Telegram messaging entry, enabled. */
  write(entry: { token: string; chatId: string }): void;
  /** Switches this agent's Telegram entry off, keeping it in the config so the person's bot and group are not lost. */
  disable(): void;
  /** Asks the supervisor for a planned restart, so the new channel starts polling. True when the request was written. */
  requestRestart(reason: string): boolean;
}

const API = 'https://api.telegram.org';

/** The production probe over the Bot API. A token never appears outside the URL this function builds. */
export async function probeTelegram(token: string, chatId: string, doFetch: typeof fetch = fetch): Promise<TelegramProbe> {
  const call = async (method: string, params: Record<string, string>): Promise<{ ok: boolean; status: number; result?: Record<string, unknown> } | undefined> => {
    try {
      const url = new URL(`${API}/bot${token}/${method}`);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      const res = await doFetch(url, { signal: AbortSignal.timeout(15_000) });
      const body = await res.json().catch(() => null) as { ok?: boolean; result?: Record<string, unknown> } | null;
      return { ok: res.ok && body?.ok === true, status: res.status, result: body?.result };
    } catch {
      // @silent-fallback-ok: "Telegram did not answer" is a state the recipe reports as unknown
      return undefined;
    }
  };
  const me = await call('getMe', {});
  if (!me) return 'unknown';
  if (me.status === 401 || me.status === 404) return 'token-refused';
  if (!me.ok) return 'unknown';
  // A moment between the two calls keeps a fresh bot under Telegram's per-second limit.
  await sleep(300);
  const chat = await call('getChat', { chat_id: chatId });
  if (!chat) return 'unknown';
  if (chat.status === 400 || chat.status === 403) return 'chat-unreachable';
  if (!chat.ok) return 'unknown';
  return chat.result?.is_forum === true ? 'ok' : 'not-forum';
}

/** The messaging entry as the recipe reads it, from a raw config object. */
export function readTelegramEntry(config: { messaging?: unknown }): TelegramEntry | null {
  const list = Array.isArray(config.messaging) ? (config.messaging as Array<Record<string, unknown>>) : [];
  const tg = list.find((m) => m?.type === 'telegram');
  if (!tg) return null;
  const cfg = (tg.config ?? {}) as Record<string, unknown>;
  const token = typeof cfg.token === 'string' ? cfg.token : '';
  const chatId = cfg.chatId === undefined || cfg.chatId === null ? '' : String(cfg.chatId);
  if (!token || !chatId) return null;
  return { token, chatId, enabled: tg.enabled !== false };
}
