/** These files carry this machine's execution custody or retained local shard.
 * Pool audit uses authenticated reads; copying a queue/permit never transfers
 * execution authority. Keep fresh installs, updates, sync and backups aligned. */
export const ORIGIN_LOCAL_PREFIXES = [
  'origin-sessions-', 'origin-notice.sock', 'state/pending-relay.',
  'state/telegram-origin-spool/', 'state/telegram-origin-archives/',
] as const;
export const ORIGIN_LOCAL_GITIGNORE = ORIGIN_LOCAL_PREFIXES.map(prefix => prefix.endsWith('/') ? prefix : `${prefix}*`);
export const ORIGIN_LOCAL_PROJECT_GLOBS = ORIGIN_LOCAL_GITIGNORE.map(entry => `.instar/${entry}`);
export const ORIGIN_LOCAL_BACKUP_PREFIXES = [...ORIGIN_LOCAL_PREFIXES, ...ORIGIN_LOCAL_PREFIXES.map(prefix => `.instar/${prefix}`)];
