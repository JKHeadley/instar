/**
 * Whether promise keeping's record rules are live on this machine
 * (docs/specs/promise-keeping-before-the-deadline.md §3.4, §7): the check-in
 * reminder gate is enabled and not dry-run. Read live, so a dry-run flip lifts
 * the PATCH and deliver rules at once. Missing config → not live.
 */
type CheckInCfg = { enabled?: boolean; dryRun?: boolean } | undefined;

export function promiseKeepingGateLive(
  liveConfig: { get?: <T>(key: string, fallback: T) => T } | null | undefined,
  config: unknown,
): boolean {
  let cfg: CheckInCfg;
  try {
    cfg = liveConfig?.get?.<CheckInCfg>('commitments.checkInReminder', undefined)
      ?? ((config as { commitments?: { checkInReminder?: CheckInCfg } } | null)?.commitments?.checkInReminder);
  } catch {
    cfg = undefined; // @silent-fallback-ok — an unreadable config is "not live": today's PATCH/deliver behavior stays
  }
  return !!cfg && cfg.enabled !== false && cfg.dryRun === false;
}
