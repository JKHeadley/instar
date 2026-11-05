/**
 * Does a machine hold a live copy of a conversation? (session-pool-activation-at-pairing,
 * Change 8.) The duplicate check asks this. It used to send this machine's bearer token,
 * which a joined machine does not share, so every probe failed and the check deferred.
 * The signed verb needs no shared token. The bearer call stays for an older peer.
 */

export type LiveCopyProbeResponse = { ok: true; live: boolean } | { ok: false; reason: string };

/** `ok:false` is the deferral signal: a failed probe is never evidence either way. */
export async function probeLiveCopyOnPeer(deps: {
  signed: () => Promise<{ ok: boolean; result?: unknown } | null>;
  bearer: () => Promise<boolean>;
}): Promise<{ ok: boolean; live: boolean }> {
  try {
    const signed = await deps.signed();
    const body = signed?.ok ? (signed.result as LiveCopyProbeResponse | undefined) : undefined;
    if (body?.ok === true && typeof body.live === 'boolean') return { ok: true, live: body.live };
  } catch {
    // @silent-fallback-ok — the bearer call below is the fallback, and its failure defers.
  }
  try {
    return { ok: true, live: await deps.bearer() };
  } catch {
    // @silent-fallback-ok — deferred by the caller, which journals it and burns an attempt.
    return { ok: false, live: false };
  }
}

/** The serve side: this machine's own sessions, as `/sessions` lists them. */
export function liveCopyInList(list: unknown, platform: string, platformId: string): boolean {
  return (Array.isArray(list) ? list as Array<Record<string, unknown>> : [])
    .some((s) => String(s.platform) === platform && String(s.platformId) === platformId);
}
