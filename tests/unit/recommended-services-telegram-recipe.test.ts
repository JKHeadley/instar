/**
 * The Telegram setup recipe (docs/specs/recommended-services.md, catalog row telegram): the check reads this
 * agent's entry and asks the Bot API; the person's bot is never replaced; a switch-off disables the entry and
 * keeps it, and asks for a planned restart. Nothing here prints a token.
 */
import { describe, expect, it } from 'vitest';
import { RECOMMENDED_SERVICE_CATALOG } from '../../src/recommended/catalog.js';
import { catalogWithProving, recipeFor, type StopDeps } from '../../src/recommended/recipes.js';
import { probeTelegram, readTelegramEntry, type TelegramProbe, type TelegramSetupSurface } from '../../src/recommended/telegramSetup.js';

const row = RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === 'telegram')!;
const recipe = recipeFor({ ...row, setupRecipe: 'telegram-v1' })!;
const TOKEN = '123456789:' + 'A'.repeat(35);

function surface(over: { entry?: { token: string; chatId: string; enabled: boolean } | null; probe?: TelegramProbe } = {}) {
  const state = { entry: over.entry === undefined ? { token: TOKEN, chatId: '-1001', enabled: true } : over.entry, probe: over.probe ?? 'ok', restarts: [] as string[], writes: 0, disabled: 0 };
  const s: TelegramSetupSurface = {
    configured: () => state.entry,
    probe: async () => state.probe,
    write: ({ token, chatId }) => { state.entry = { token, chatId, enabled: true }; state.writes += 1; },
    disable: () => { if (state.entry) state.entry = { ...state.entry, enabled: false }; state.disabled += 1; },
    requestRestart: (reason) => { state.restarts.push(reason); return true; },
  };
  return { s, state };
}

describe('the Bot API probe', () => {
  const fetchWith = (answers: Record<string, { status: number; body: unknown }>) => (async (url: URL) => {
    const method = url.pathname.split('/').pop()!;
    const a = answers[method] ?? { status: 404, body: { ok: false } };
    return new Response(JSON.stringify(a.body), { status: a.status });
  }) as unknown as typeof fetch;
  it('ok only when the bot answers and the group is a forum; each refusal has its own name; silence is unknown', async () => {
    const me = { status: 200, body: { ok: true, result: { id: 1 } } };
    expect(await probeTelegram(TOKEN, '-1001', fetchWith({ getMe: me, getChat: { status: 200, body: { ok: true, result: { is_forum: true } } } }))).toBe('ok');
    expect(await probeTelegram(TOKEN, '-1001', fetchWith({ getMe: me, getChat: { status: 200, body: { ok: true, result: { type: 'group' } } } }))).toBe('not-forum');
    expect(await probeTelegram(TOKEN, '-1001', fetchWith({ getMe: me, getChat: { status: 400, body: { ok: false } } }))).toBe('chat-unreachable');
    expect(await probeTelegram(TOKEN, '-1001', fetchWith({ getMe: { status: 401, body: { ok: false } } }))).toBe('token-refused');
    expect(await probeTelegram(TOKEN, '-1001', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBe('unknown');
  });
  it('reads this agent entry from the config, and treats a missing token or chat id as none', () => {
    expect(readTelegramEntry({ messaging: [{ type: 'telegram', enabled: true, config: { token: TOKEN, chatId: -1001 } }] })).toEqual({ token: TOKEN, chatId: '-1001', enabled: true });
    expect(readTelegramEntry({ messaging: [{ type: 'telegram', enabled: false, config: { token: TOKEN, chatId: '-1001' } }] })?.enabled).toBe(false);
    expect(readTelegramEntry({ messaging: [{ type: 'slack', config: {} }] })).toBeNull();
    expect(readTelegramEntry({ messaging: [{ type: 'telegram', config: { token: TOKEN } }] })).toBeNull();
    expect(readTelegramEntry({})).toBeNull();
  });
});

describe('the telegram-v1 recipe', () => {
  it('is dark: proving agents only, until its live proof', () => {
    expect(row.setupRecipe).toBeNull();
    expect(row.wayIn).toBe(true);
    expect(recipe.secretName).toBeNull();
    expect(recipeFor(catalogWithProving(['telegram-v1'], () => true).find((r) => r.id === 'telegram')!)?.id).toBe('telegram-v1');
  });

  it('the check: absent with no entry, fail when switched off or refused, pass when the bot and forum answer, unknown on silence', async () => {
    const v = (over: Parameters<typeof surface>[0]) => recipe.verify({ readSecret: () => null, telegramSetup: surface(over).s });
    expect(await v({ entry: null })).toMatchObject({ result: 'fail', absent: true });
    expect((await v({ entry: { token: TOKEN, chatId: '-1001', enabled: false } })).result).toBe('fail');
    expect((await v({ probe: 'ok' })).result).toBe('pass');
    expect((await v({ probe: 'token-refused' })).detail).toContain('refused the bot token');
    expect((await v({ probe: 'not-forum' })).detail).toContain('no topics');
    expect((await v({ probe: 'unknown' })).result).toBe('unknown');
    expect((await recipe.verify({ readSecret: () => null })).result).toBe('unknown');
  });

  it('a switch-off disables the entry, keeps it, and asks for a planned restart; a Telegram the person had is left alone', async () => {
    const mine = surface();
    const out = await recipe.stop({ readSecret: () => null, deleteSecret: () => undefined, setUpHere: true, telegramSetup: mine.s } as StopDeps);
    expect(out).toMatchObject({ stopped: true, changed: true });
    expect(mine.state.entry).toMatchObject({ token: TOKEN, chatId: '-1001', enabled: false });
    expect(mine.state.restarts).toHaveLength(1);
    const theirs = surface();
    expect(await recipe.stop({ readSecret: () => null, deleteSecret: () => undefined, setUpHere: false, telegramSetup: theirs.s } as StopDeps)).toMatchObject({ changed: false });
    expect(theirs.state.entry?.enabled).toBe(true);
    expect(theirs.state.restarts).toHaveLength(0);
  });

  it('the brief: the person supplies only their phone number and login code through Secret Drop; the token is never printed; no bot is ever deleted', () => {
    const brief = recipe.brief({ port: 4042 });
    expect(brief).toContain('through one Secret Drop, never in chat');
    expect(brief).toContain('never put it in a command line or a web address, and never call the Bot API yourself');
    expect(brief).toContain('web.telegram.org/k/#-100');
    // An agent with no Telegram yet runs this setup with no topic, where the dashboard lists it.
    expect(brief).toContain("If $INSTAR_TELEGRAM_TOPIC is empty, this agent has no Telegram yet");
    expect(brief).toContain('Never delete any of their bots');
    expect(brief).toContain('/recommended-services/telegram/key');
    expect(brief).toContain('X-Telegram-Chat-Id');
    expect(brief).toContain('sign the browser out of Telegram Web');
    expect(brief).not.toMatch(/ask (them|the person) to (go|visit|open|run|paste)/i);
  });
});
