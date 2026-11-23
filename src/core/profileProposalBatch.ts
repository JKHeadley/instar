/** Server-owned batch disclosure. This module never authorizes consent. */
import type { ProfilePatchInput } from './topicProfileValidation.js';
import type { TopicProfileWriteSurface } from './topicProfileWriteSurface.js';
import type { ProfileProposalItem } from './ProfileProposalRequests.js';
import { formatForTelegram, type FormatMode } from '../messaging/TelegramMarkdownFormatter.js';
import { isIssuesTopicId, ISSUES_TOPIC_OFFSET } from '../messaging/telegramTopicSpace.js';

/** The deployed formatter supports literal inline code, but not Markdown backslash escaping. */
export function escapeProfileProposalName(name: string): string {
  const literal = name.replace(/[\r\n\t\u0000]/g, ' ').replace(/`/g, '｀').replace(/[\u{100000}-\u{10FFFD}]/gu, '');
  return `\`${literal}\``;
}

/** Native forum topic URL, derived only from configured chat identity and canonical target. */
export function telegramProfileTopicLink(chatId: string | number, target: string): string | null {
  const chat = String(chatId);
  if (!/^-100[1-9]\d*$/.test(chat) || !/^[1-9]\d*$/.test(target) || !Number.isSafeInteger(Number(target))) return null;
  return `https://t.me/c/${chat.slice(4)}/${target}`;
}

function safeTargetLink(raw: string | null, target: string): string | null {
  if (!raw || /[\r\n\u0000]/.test(raw)) return null;
  try {
    const wireTarget = isIssuesTopicId(target) ? String(Number(target) - ISSUES_TOPIC_OFFSET) : target;
    const url = new URL(raw);
    if (!['https:', 'http:', 'tg:'].includes(url.protocol) || url.username || url.password) return null;
    const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '');
    const explicitTarget = url.searchParams.get('thread') ?? url.searchParams.get('message_thread_id') ?? url.searchParams.get('post');
    if (url.protocol === 'tg:' ? (explicitTarget ?? last) !== wireTarget : last !== wireTarget) return null;
    if (explicitTarget !== null && explicitTarget !== wireTarget) return null;
    // Markdown URL scanning treats parentheses structurally, even for trusted URLs.
    const safe = url.href.replace(/\(/g, '%28').replace(/\)/g, '%29');
    // Check the actual formatter preserves the native destination too. In
    // particular a query separator must not become a literal amp; parameter.
    const formatted = formatForTelegram(`[Open this conversation](${safe})`).text;
    const attributeEntities: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&lt;': '<', '&gt;': '>' };
    const href = formatted.match(/<a href="([^"]+)">/)?.[1]
      ?.replace(/&(?:amp|quot|lt|gt);/g, x => attributeEntities[x]);
    return href === safe ? safe : null;
  } catch { return null; }
}

/** One actual formatted Telegram text payload, after HTML entity parsing.
 * Uses UTF-16 units, matching the adapter's string budget and entity offsets.
 */
export function profileProposalFitsTelegram(text: string, mode: FormatMode = 'markdown'): boolean {
  try {
    const formatted = formatForTelegram(text, mode);
    if (formatted.truncated || formatted.conversionSkipped) return false;
    if (formatted.parseMode !== 'HTML') return formatted.text.length <= 4096;
    const withoutTags = formatted.text.replace(/<\/?(?:b|strong|i|em|u|ins|s|strike|del|span|tg-spoiler|a|code|pre|blockquote|tg-emoji)(?:\s[^<>]*)?>/gi, '');
    if (/[<>]/.test(withoutTags)) return false;
    const visible = withoutTags.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, entity => {
      const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
      if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
      const hex = entity.slice(0, 3).toLowerCase() === '&#x';
      return String.fromCodePoint(Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10));
    });
    return visible.length > 0 && visible.length <= 4096;
  } catch { return false; }
}

export function renderProfileBatchProposal(input: {
  source: string;
  targets: readonly { target: string; patch: ProfilePatchInput }[];
  surface: TopicProfileWriteSurface;
  name: (target: string) => string;
  link: (target: string) => string | null;
  placement: (target: string) => string | null;
}): { ok: true; core: string; items: ProfileProposalItem[] } | { ok: false; reason: string; message: string } {
  if (!input.targets.length || new Set(input.targets.map(x => x.target)).size !== input.targets.length) {
    return { ok: false, reason: 'invalid-targets', message: 'Choose each conversation once, with at least one conversation.' };
  }
  const names = input.targets.map(x => escapeProfileProposalName(input.name(x.target)));
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const items: ProfileProposalItem[] = []; const sections: string[] = [];
  for (let i = 0; i < input.targets.length; i++) {
    const { target, patch } = input.targets[i];
    const contextStamp = input.placement(target);
    if (!contextStamp) return { ok: false, reason: 'placement-unavailable', message: 'I need to verify where every conversation is running before asking you to approve this.' };
    const rendered = input.surface.renderProposalEcho(target, patch, names[i]);
    if (!rendered.ok) return { ok: false, reason: 'invalid-change', message: rendered.reply };
    let identity = '';
    if ((counts.get(names[i]) ?? 0) > 1) {
      const link = safeTargetLink(input.link(target), target);
      if (!link) return { ok: false, reason: 'target-link-unavailable', message: 'These conversations have the same name. I need a verified conversation link for each before asking you to approve them.' };
      identity = `Conversation ${i + 1}: [Open this conversation](${link})\n`;
    }
    items.push({ target, patch: JSON.parse(JSON.stringify(rendered.patch)) as ProfilePatchInput, core: rendered.echo, contextStamp, baselineStamp: rendered.baselineStamp });
    sections.push(`${identity}${rendered.echo}`);
  }
  const core = `Approve these conversation changes together?\n\n${sections.join('\n\n')}`;
  if (!profileProposalFitsTelegram(core)) return { ok: false, reason: 'question-too-large', message: 'The full changes do not fit in one question. I can prepare a smaller group without leaving out any effects.' };
  return { ok: true, core, items };
}
