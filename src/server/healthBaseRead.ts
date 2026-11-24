/** The production health base projection over explicit observations; no host reads or singleton access. */
export interface HealthBaseInput {
  uptimeMs: number; uptimeHuman: string; sessionExhausted: boolean; totalFailures: number;
  degradations: number; degradationSummary: () => unknown[];
  llmReliability: { status: string } | null;
  claudeKeyDead: () => boolean;
  gateRouteVersion: number; gateRouteMinimumVersion: number;
}
export function buildHealthBase(input: HealthBaseInput): { base: Record<string, unknown>; isDegraded: boolean } {
  const isDegraded = input.sessionExhausted || input.totalFailures >= 5 || input.degradations > 0
    || (input.llmReliability !== null && input.llmReliability.status !== 'ok') || input.claudeKeyDead();
  return { isDegraded, base: {
    status: isDegraded ? 'degraded' : 'ok', uptime: input.uptimeMs, uptimeHuman: input.uptimeHuman,
    degradations: input.degradations,
    ...(input.llmReliability ? { llmReliability: input.llmReliability } : {}),
    ...(input.degradations > 0 && { degradationSummary: input.degradationSummary() }),
    gateRouteVersion: input.gateRouteVersion, gateRouteMinimumVersion: input.gateRouteMinimumVersion,
  } };
}
export function healthProjectProjection(authenticated: boolean, projectName: string): Record<string, unknown> {
  return authenticated ? { project: projectName } : {};
}

export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
