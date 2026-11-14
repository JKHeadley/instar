/** The peer's final step can block its server for many seconds, which a status
 * read sees as unreachable. Keep polling across that, within a limit. */
export const SOURCE_STATUS_UNREACHABLE_LIMIT_MS=120000;
export const SOURCE_STATUS_RETRY_MS=500;
export function sourceStatusPollGivesUp(unreachableSince:number,now:number):boolean{return now-unreachableSince>SOURCE_STATUS_UNREACHABLE_LIMIT_MS;}
