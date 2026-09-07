/** Server-private worker. Not an MCP entrypoint. Without its inherited IPC channel it does nothing. */
import { TelegramClient, Api, version } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { type MtprotoEnrollment } from './EnrolledMtprotoDriver.js';
import { type PreparedBrowserChild } from './BrowserTypes.js';

const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const snake = (key: string) => key.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
/** Translate TL field spelling/constructors only. The sealed text, entities and integer strings stay exact. */
export function toMtprotoArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toMtprotoArguments);
  if (!value || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(obj)) {
    if (key === '_') continue;
    if (key === 'pFlags') { Object.assign(result, toMtprotoArguments(item)); continue; }
    result[camel(key)] = toMtprotoArguments(item);
  }
  if (typeof obj._ === 'string') {
    const name = obj._[0].toUpperCase() + obj._.slice(1);
    const Constructor = (Api as unknown as Record<string, new (args: Record<string, unknown>) => unknown>)[name];
    if (!Constructor || !/^(InputPeer|InputReplyTo|MessageEntity|InputMessageEntity)/.test(name)) throw new Error('unsupported-tl-constructor');
    return new Constructor(result);
  }
  return result;
}
export function fromMtprotoResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromMtprotoResult);
  if (!value || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  if (typeof obj.toArray === 'function' && typeof obj.toString === 'function') return String(obj);
  const result: Record<string, unknown> = {};
  if (typeof obj.className === 'string') result._ = obj.className[0].toLowerCase() + obj.className.slice(1);
  for (const [key, item] of Object.entries(obj)) {
    if (key.startsWith('_') || ['className', 'classType', 'CONSTRUCTOR_ID', 'SUBCLASS_OF_ID', 'originalArgs'].includes(key)
      || item === undefined || typeof item === 'function') continue;
    result[snake(key)] = fromMtprotoResult(item);
  }
  return result;
}

// Importing the serializers in another IPC-enabled process must not attach a
// worker to that process's channel (for example a forked test runner).
if (process.send && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let client: TelegramClient | undefined;
  let accountId = '';
  let tail = Promise.resolve();
  process.on('message', (message: unknown) => {
    const m = message as { id: number; op: string; value?: unknown };
    tail = tail.then(async () => {
      try {
        let result: unknown;
        if (m.op === 'enroll' && !client) {
          const e = m.value as MtprotoEnrollment;
          accountId = e.expectedAccountId;
          client = new TelegramClient(new StringSession(e.sessionString), e.apiId, e.apiHash, {
            requestRetries: 1, connectionRetries: 0, autoReconnect: false, floodSleepThreshold: 0,
          });
          await client.connect();
          const me = await client.getMe();
          if (String(me.id) !== accountId) throw new Error('mtproto-account-mismatch');
          result = true;
        } else if (m.op === 'canary' && client) {
          const me = await client.getMe();
          result = { transport: 'mtproto', buildId: `gramjs:${version}`, accountId: String(me.id), supported: String(me.id) === accountId };
        } else if (m.op === 'invoke' && client) {
          const child = m.value as PreparedBrowserChild;
          const me = await client.getMe();
          if (String(me.id) !== accountId || child.accountId !== accountId || Date.now() >= child.deadlineMs) throw new Error('mtproto-dispatch-held');
          const args = toMtprotoArguments(child.args) as ConstructorParameters<typeof Api.messages.SendMessage>[0];
          const request = child.method === 'messages.sendMessage' ? new Api.messages.SendMessage(args)
            : child.method === 'messages.editMessage' ? new Api.messages.EditMessage(args as ConstructorParameters<typeof Api.messages.EditMessage>[0]) : null;
          if (!request) throw new Error('unsupported-method');
          result = fromMtprotoResult(await client.invoke(request));
        } else throw new Error('mtproto-operation-unavailable');
        process.send?.({ id: m.id, result });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        process.send?.({ id: m.id, ...(typeof code === 'number' ? { refusalCode: code } : { failed: true }) });
      }
    });
  });
  process.once('disconnect', () => process.exit(0));
}
