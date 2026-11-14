/** A platform identifier is routing data; it is never a display name. */
export type ChannelPlatform = 'telegram' | 'slack';

export interface VerifiedChannelIdentity {
  platform: ChannelPlatform;
  id: string;
  name: string;
}

/** Shared user-facing identity rule for channels, machines, and agents. */
export function verifiedEntityName(id: string | number, candidate: unknown): string | null {
  const key = String(id).trim();
  const name = typeof candidate === 'string' ? candidate.trim() : '';
  if (!key || !name || name === key) return null;
  if (/^\d+$/.test(name)) return null;
  if (/^(?:\[deleted\]\s*)?(?:telegram\s+)?topic[-\s#]*\d+$/i.test(name)) return null;
  // Peer inventories sometimes supply the first eight hex characters of a
  // fingerprint as a supposed name. A shortened identifier is still an ID.
  if (/^[a-f0-9]{8,}(?:…|\.\.\.)?$/i.test(name) || /^m_[a-z0-9]{12,}$/i.test(name) || /^[CGD][A-Z0-9]{8,}$/.test(name)) return null;
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(name)) return null;
  if (/^a2aproof-\d+$/i.test(name)) return null;
  if (/^(?:conversation|channel|agent|machine|account|session|topic|initiative|project|subsystem|work item) name unavailable$/i.test(name) || /^(?:an? )?unnamed (?:agent|machine|account|session|feature|person|part)$/i.test(name) || /^(?:another machine|a machine with no name yet|the account|promise details unavailable)$/i.test(name) || /^checking (?:conversation|channel) name/i.test(name)) return null;
  return name;
}

export function verifiedChannelIdentity(platform: ChannelPlatform, id: string | number, candidate: unknown): VerifiedChannelIdentity | null {
  const key = String(id).trim();
  const name = verifiedEntityName(id, candidate);
  if (!name) return null;
  if (platform === 'slack' && (name === `#${key}` || name.startsWith(`${key} (thread `))) return null;
  return { platform, id: key, name };
}

export function isVerifiedChannelName(platform: ChannelPlatform, id: string | number, candidate: unknown): candidate is string {
  return verifiedChannelIdentity(platform, id, candidate) !== null;
}

export interface IdNameResolvers {
  topicName?: (topicId: number) => string | null | undefined;
  machineName?: (machineId: string) => string | null | undefined;
}

/**
 * Replace raw topic and machine ids in operator-facing text with their names.
 * "topic 127504" / "telegram:127504" → 'topic "Instar dashboard makeover"';
 * "m_03b3…" → "Mac Studio". An id with no verified name is left as written,
 * so the text never claims a name it does not have.
 */
export function nameIdsInText(text: string, resolve: IdNameResolvers): string {
  if (!text) return text;
  let out = text;
  if (resolve.topicName) {
    const name = (id: string) => verifiedEntityName(id, safe(() => resolve.topicName!(Number(id))));
    out = out.replace(/\b(Topic|topic)(\s+#?)(\d{2,})(?!\d)/g, (m, word: string, _sp: string, id: string) => {
      const n = name(id); return n ? `${word} "${n}"` : m;
    });
    out = out.replace(/\b(Conversation|conversation)\s+telegram:(\d{2,})\b/g, (m, word: string, id: string) => {
      const n = name(id); return n ? `${word} "${n}"` : m;
    });
    out = out.replace(/\btelegram:(\d{2,})\b/g, (m, id: string) => {
      const n = name(id); return n ? `"${n}"` : m;
    });
  }
  if (resolve.machineName) {
    out = out.replace(/\b(?:[Mm]achine\s+)?(m_[0-9a-f]{12,})\b/g, (m, id: string) => {
      const n = verifiedEntityName(id, safe(() => resolve.machineName!(id)));
      // "Machine m_…" becomes just the nickname ("Mac Studio is flapping").
      return n ?? m;
    });
  }
  return out;
}

function safe<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}
