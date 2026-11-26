// Server projections grant actions for this exact signed browser and conversation.
export function chatMessageActions(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const reply = raw.reply === true;
  const emoji = Array.isArray(raw.reactions?.emoji)
    ? [...new Set(raw.reactions.emoji.filter(value => typeof value === 'string' && value.trim() && value.length <= 16))].slice(0, 20)
    : [];
  const custodian = exactId(raw.forward?.custodianMachineId);
  return reply || emoji.length || custodian ? { reply, emoji, custodian } : null;
}

export function exactId(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 128 ? value : null;
}

export function replyPreview(raw) {
  if (raw?.state === 'unavailable') return { state: 'unavailable' };
  const eventId = exactId(raw?.eventId);
  if (raw?.state !== 'available' || !eventId || typeof raw.preview !== 'string') return null;
  return { state: 'available', eventId, preview: raw.preview, senderName: typeof raw.senderName === 'string' ? raw.senderName : '' };
}

export function reactionState(data, eventId) {
  return data?.eventId === eventId ? ownReaction(data.own) : null;
}

export function ownReaction(own) {
  return own && Number.isSafeInteger(own.revision) && own.revision >= 0
    && (own.emoji === null || typeof own.emoji === 'string') ? { revision: own.revision, emoji: own.emoji } : null;
}

export function forwardDestinations(rows, sourceKey, custodian) {
  if (!custodian) return [];
  return rows.filter(row => row.kind === 'app' && row.key !== sourceKey && row.messageActions?.custodian === custodian);
}
