/**
 * machineServesChannel — the pure, three-valued eligibility function for
 * platform/workspace-aware placement (spec docs/specs/placement-platform-workspace-aware.md).
 *
 * RULE 3: EXEMPT — this is pure set-membership logic over an already-parsed capability
 * object (`MachineCapacity.servesChannels`); it reads no provider/CLI output and detects
 * no external state. Not a provider-state detector.
 *
 * Returns THREE values, not a boolean — the spec's load-bearing distinction:
 *   - `'yes'`     — present, fresh signal AND the channel's scope is in the set (workspace-reachable).
 *   - `'no'`      — present, fresh signal AND the scope is NOT in the set (STRUCTURALLY cannot serve).
 *   - `'unknown'` — no trustworthy signal (absent field — an older heartbeat — OR a legacy
 *                   request carrying no channel scope). FAIL-OPEN: treated as eligible.
 *
 * Why three-valued (not boolean): placement must tell "structurally cannot serve" (never
 * place there — it's a permanent black-hole) apart from "don't know yet" (fail-open during a
 * rolling deploy). A boolean collapses those and either strands old peers or recreates the bug.
 *
 * Freshness is handled UPSTREAM (PlacementExecutor's input is already liveness-filtered, and
 * the heartbeat producer clears a workspace id on adapter disconnect) — so a present field on
 * a machine the registry still serves is trusted here; this function does no time math.
 */

/** The capability signal carried in MachineCapacity.servesChannels (adapter-DERIVED, not config). */
export interface ServesChannels {
  telegram?: { chatIds: string[] };
  slack?: { workspaceIds: string[] };
}

/** The channel scope threaded into the placement request. */
export interface ChannelScope {
  platform: 'telegram' | 'slack';
  /** Telegram supergroup chat id (telegram only). */
  chatId?: string;
  /** Slack workspace/team id (slack only). */
  workspaceId?: string;
}

export type ServeResult = 'yes' | 'no' | 'unknown';

export function machineServesChannel(
  serves: ServesChannels | undefined,
  scope: ChannelScope | undefined,
): ServeResult {
  // Legacy caller passed no channel scope → we can't evaluate → fail-open.
  if (!scope) return 'unknown';
  // Older heartbeat predating this field → no trustworthy signal → fail-open.
  if (!serves) return 'unknown';

  if (scope.platform === 'telegram') {
    const ids = serves.telegram?.chatIds;
    // A present `servesChannels` with NO telegram block is an explicit "this machine does not
    // poll any telegram chat" — that's a real `no`, not unknown. (Absent whole field is handled above.)
    if (ids === undefined) return 'no';
    if (scope.chatId === undefined) return 'unknown'; // request lacks the scope value
    return ids.includes(scope.chatId) ? 'yes' : 'no';
  }

  // slack
  const ids = serves.slack?.workspaceIds;
  if (ids === undefined) return 'no';
  if (scope.workspaceId === undefined) return 'unknown';
  return ids.includes(scope.workspaceId) ? 'yes' : 'no';
}
