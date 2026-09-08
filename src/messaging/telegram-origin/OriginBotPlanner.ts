import { randomUUID } from 'node:crypto';
import { canonicalOrigin, originDigest, parseOriginJson, wireDigest } from './CanonicalOrigin.js';
import { escapeOriginFooter, originFooter } from './OriginPresentation.js';
import { TelegramOriginHoldError } from './types.js';
import type { BotParameters, OriginDestination, OriginDisplaySnapshot, OriginPreparedChild, TelegramOriginProducer } from './types.js';
import { sealOriginMultipart, type PreparedOriginAttachments } from './OriginMultipart.js';

function id(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.length && value.length <= 256) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  throw new TelegramOriginHoldError('invalid-platform-identity');
}
export function botDestination(accountId: string, params: BotParameters): OriginDestination {
  return { version: 1, transport: 'bot-api', accountId, chatId: id(params.chat_id),
    topicId: id(params.message_thread_id), messageId: id(params.message_id),
    inlineMessageId: id(params.inline_message_id), scheduledMessageId: null };
}
function scalarChunks(value: string, capacity: number): string[] {
  const result: string[] = []; let chunk = '';
  for (const scalar of value) {
    if (chunk.length + scalar.length > capacity) { result.push(chunk); chunk = ''; }
    chunk += scalar;
  }
  if (chunk) result.push(chunk);
  return result;
}
/** Close/reopen nested Telegram HTML tags at each split; never split an entity or Unicode scalar. */
export function splitOriginHtml(html: string, capacity: number): string[] {
  const tokens = html.match(/<[^>]*>|&(?:#[0-9]+|#x[0-9a-fA-F]+|[A-Za-z]+);|[^<&]+|[<&]/gu) ?? [];
  const stack: Array<{ open: string; name: string }> = [];
  const result: string[] = []; let current = ''; let visible = 0;
  const closeTags = () => [...stack].reverse().map(t => `</${t.name}>`).join('');
  const flush = () => { if (visible) result.push(current + closeTags()); current = stack.map(t => t.open).join(''); visible = 0; };
  for (const token of tokens) {
    if (token.startsWith('<') && token.endsWith('>')) {
      const tag = /^<(\/)?([a-z][a-z0-9-]*)(?:\s[^>]*)?>$/i.exec(token);
      if (!tag) throw new TelegramOriginHoldError('unsupported-html-form');
      const name = tag[2].toLowerCase();
      if (tag[1]) {
        if (stack.at(-1)?.name !== name) throw new TelegramOriginHoldError('unbalanced-html');
        stack.pop();
      } else stack.push({ open: token, name });
      current += token; continue;
    }
    const scalars = token.startsWith('&') && token.endsWith(';') ? [token] : [...token];
    for (const scalar of scalars) {
      const size = scalar.startsWith('&') && scalar.endsWith(';')
        ? (/^&#(?:x([\da-f]+)|(\d+));$/i.exec(scalar)?.slice(1).some(Boolean) ? 2 : 1) : scalar.length;
      if (visible + size > capacity) flush();
      current += scalar; visible += size;
    }
  }
  if (stack.length) throw new TelegramOriginHoldError('unbalanced-html');
  if (visible) result.push(current);
  return result;
}

export function planBotOrigin(input: { method: string; accountId: string; params: BotParameters;
  producer: TelegramOriginProducer; display: OriginDisplaySnapshot; maxChildren?: number; attachments?: PreparedOriginAttachments }): {
    destination: OriginDestination; contentDigest: string; children: OriginPreparedChild[];
  } {
  const params = parseOriginJson(canonicalOrigin(input.params)) as BotParameters;
  if (params.rich_message !== undefined) throw new TelegramOriginHoldError('unsupported-origin-rich-message');
  const destination = botDestination(input.accountId, params);
  if (!input.method.startsWith('edit')) destination.messageId = null;
  if (!destination.chatId && !destination.inlineMessageId) throw new TelegramOriginHoldError('destination-required');
  if (input.attachments && !['sendPhoto', 'sendVideo', 'sendAudio', 'sendDocument', 'sendAnimation', 'sendVoice', 'sendVideoNote', 'sendSticker', 'sendMediaGroup', 'editMessageMedia'].includes(input.method)) throw new TelegramOriginHoldError('unsupported-attachment-method');
  const contentDigest = originDigest({ method: input.method, destination, params,
    ...(input.attachments ? { attachments: input.attachments.refs } : {}) });
  const footer = originFooter(input.producer, input.display);
  let nestedFullyCaptioned = false;
  if (['sendMediaGroup', 'editMessageMedia'].includes(input.method) && params.media !== undefined) {
    const wasString = typeof params.media === 'string';
    const media = wasString ? parseOriginJson(params.media as string) : params.media;
    const items = Array.isArray(media) ? media : [media];
    nestedFullyCaptioned = items.length > 0 && items.every(item => item && typeof item === 'object' && !Array.isArray(item)
      && typeof item.caption === 'string' && item.caption.length > 0);
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.caption !== 'string' || !item.caption || !footer) continue;
      const mode = typeof item.parse_mode === 'string' ? item.parse_mode : undefined;
      const capacity = 1024 - footer.length - 2;
      if (capacity < 64) throw new TelegramOriginHoldError('origin-display-too-long');
      const chunks = mode === 'HTML' ? splitOriginHtml(item.caption, capacity) : [item.caption];
      if (chunks.length !== 1 || (mode !== 'HTML' && item.caption.length > capacity)) throw new TelegramOriginHoldError('revision-or-caption-too-long');
      item.caption = chunks[0] + `\n\n${escapeOriginFooter(footer, mode)}`;
    }
    params.media = wasString ? canonicalOrigin(media) : media;
  }
  const field = typeof params.text === 'string' ? 'text' : typeof params.caption === 'string' && params.caption ? 'caption' : null;
  if (!field) {
    const supported = new Set(['sendPhoto', 'sendVideo', 'sendAudio', 'sendDocument', 'sendAnimation', 'sendVoice',
      'sendVideoNote', 'sendSticker', 'sendMediaGroup', 'forwardMessage', 'forwardMessages', 'copyMessage', 'copyMessages', 'editMessageMedia', 'editMessageCaption']);
    if (!supported.has(input.method) || params.rich_message !== undefined) throw new TelegramOriginHoldError('unsupported-origin-message-form');
    const childId = randomUUID();
    const request = { method: input.method, accountId: input.accountId, destination,
      contentType: 'application/json' as const, body: canonicalOrigin(params) };
    if (input.attachments) sealOriginMultipart(request, input.attachments);
    const children: OriginPreparedChild[] = [{ childId, materializationId: randomUUID(), request,
      requestDigest: wireDigest(canonicalOrigin(request)) }];
    if (footer && !nestedFullyCaptioned) {
      const companionParams: BotParameters = { chat_id: params.chat_id, text: footer };
      for (const key of ['message_thread_id', 'disable_notification', 'protect_content'] as const) {
        if (params[key] !== undefined) companionParams[key] = params[key];
      }
      if (!destination.chatId || destination.inlineMessageId) throw new TelegramOriginHoldError('companion-destination-unavailable');
      const companion = { method: 'sendMessage', accountId: input.accountId,
        destination: { ...destination, messageId: null }, contentType: 'application/json' as const,
        body: canonicalOrigin(companionParams), companionOf: childId };
      children.push({ childId: randomUUID(), materializationId: randomUUID(), request: companion,
        requestDigest: wireDigest(canonicalOrigin(companion)) });
    }
    return { destination, contentDigest, children };
  }
  const original = params[field] as string;
  const mode = typeof params.parse_mode === 'string' ? params.parse_mode : undefined;
  const renderedFooter = escapeOriginFooter(footer, mode);
  const capacity = (field === 'caption' ? 1024 : 4096) - (footer ? footer.length + 2 : 0);
  if (capacity < 64) throw new TelegramOriginHoldError('origin-display-too-long');
  let chunks: string[];
  if (mode === 'HTML') chunks = splitOriginHtml(original, capacity);
  else if (original.length <= capacity) chunks = [original];
  else if (mode) throw new TelegramOriginHoldError('unsupported-formatted-split');
  else chunks = scalarChunks(original, capacity);
  if (!chunks.length) throw new TelegramOriginHoldError('empty-original');
  if (chunks.length > 1 && input.method !== 'sendMessage') throw new TelegramOriginHoldError('revision-or-caption-too-long');
  if (chunks.length > (input.maxChildren ?? 100)) throw new TelegramOriginHoldError('child-capacity');
  let offset = 0;
  const children = chunks.map(chunk => {
    const childParams: BotParameters = { ...params, [field]: chunk + (footer ? `\n\n${renderedFooter}` : '') };
    const entityKey = field === 'caption' ? 'caption_entities' : 'entities';
    if (Array.isArray(params[entityKey]) && chunks.length > 1) {
      childParams[entityKey] = params[entityKey].flatMap(e => {
        if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.offset !== 'number' || typeof e.length !== 'number') throw new TelegramOriginHoldError('invalid-entity');
        const begin = Math.max(e.offset, offset), end = Math.min(e.offset + e.length, offset + chunk.length);
        return end > begin ? [{ ...e, offset: begin - offset, length: end - begin }] : [];
      });
    }
    offset += chunk.length;
    const request = { method: input.method, accountId: input.accountId, destination,
      contentType: 'application/json' as const, body: canonicalOrigin(childParams) };
    if (input.attachments) sealOriginMultipart(request, input.attachments);
    return { childId: randomUUID(), materializationId: randomUUID(), request, requestDigest: wireDigest(canonicalOrigin(request)) };
  });
  return { destination, contentDigest, children };
}
