/**
 * The id, login folder name and pool slot for a subscription account the owner adds from the phone
 * (docs/specs/account-add-face-id.md). Pure: the caller says which ids are taken and supplies the
 * random suffix, so collisions are tested without luck.
 *
 * Ids follow the pool's own shape (`^[a-z0-9-]+$`, SubscriptionPool ID_RE) and the existing naming:
 * Claude accounts `<name>-<suffix>`, Codex accounts `codex-<name>-<suffix>`, so the login folder is
 * `~/.claude-followme-<id>` / `~/.codex-followme-<id>` (followMeConfigHomePrefix), like every
 * account added through follow-me.
 */

/** The phone's two choices, mapped to the pool's provider and framework. */
export const NEW_ACCOUNT_KINDS = {
  claude: { provider: 'anthropic', framework: 'claude-code' },
  codex: { provider: 'openai', framework: 'codex-cli' },
} as const;
export type NewAccountKind = keyof typeof NEW_ACCOUNT_KINDS;

export function isNewAccountKind(v: unknown): v is NewAccountKind {
  return v === 'claude' || v === 'codex';
}

/** Longest name part kept in an id (the suffix and prefix are added on top). */
export const MAX_ID_NAME_CHARS = 32;
/** How many suffixes are tried before the caller is told every one was taken. */
export const MAX_ID_ATTEMPTS = 8;

/** The name part: lower-case letters, digits and single hyphens, from the nickname or the email's local part. */
export function idNamePart(nickname: string | null | undefined, email: string): string {
  const source = nickname && nickname.trim() ? nickname : email.split('@')[0] ?? '';
  const slug = source.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_ID_NAME_CHARS).replace(/-+$/g, '');
  return slug || 'account';
}

/**
 * A fresh id no one holds: `[codex-]<name>-<suffix>`. `taken` answers for an id (pool, pending
 * sign-ins, other machines, an existing login folder); `suffix` returns 4 lower-case hex characters.
 * Returns null when every attempt was taken.
 */
export function deriveNewAccountId(
  kind: NewAccountKind,
  nickname: string | null | undefined,
  email: string,
  taken: (id: string) => boolean,
  suffix: () => string,
): string | null {
  let name = idNamePart(nickname, email);
  if (kind === 'codex' && (name === 'codex' || name.startsWith('codex-'))) name = name.replace(/^codex-?/, '') || 'account';
  const base = kind === 'codex' ? `codex-${name}` : name;
  for (let i = 0; i < MAX_ID_ATTEMPTS; i++) {
    const s = suffix();
    if (!/^[0-9a-f]{4}$/.test(s)) continue;
    const id = `${base}-${s}`;
    if (/^[a-z0-9-]+$/.test(id) && !taken(id)) return id;
  }
  return null;
}
