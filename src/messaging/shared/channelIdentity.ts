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
  if (/^(?:conversation|channel|agent|machine|account|session|topic) name unavailable$/i.test(name) || /^(?:an? )?unnamed (?:agent|machine|account|session|feature|person|part)$/i.test(name) || /^checking (?:conversation|channel) name/i.test(name)) return null;
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
