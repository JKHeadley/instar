/**
 * The agent's own live secret values, for the layer store's live-value pass
 * (context-budget-layered-summaries §9.7: "plus a live-value pass against the
 * agent's own secrets (auth token, lifeline secret, secret-store values),
 * because shape patterns miss `KEY=value` dumps").
 *
 * Every source is best-effort: a machine with no lifeline secret or no
 * readable secret store still gets the shape scrub and the values it has.
 */
import { SecretStore } from '../../core/SecretStore.js';
import { readLifelineIngressSecret } from '../../core/LifelineIngressSecret.js';

export interface LiveSecretSources {
  stateDir: string;
  authToken?: unknown;
  dashboardPin?: unknown;
  forceFileKey?: boolean;
}

function collectStringLeaves(v: unknown, out: string[], depth = 0): void {
  if (depth > 8 || v == null) return;
  if (typeof v === 'string') { out.push(v); return; }
  if (typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) collectStringLeaves(x, out, depth + 1);
}

export function collectAgentLiveSecrets(src: LiveSecretSources, onStoreError?: (err: unknown) => void): string[] {
  const out: string[] = [src.authToken, src.dashboardPin].filter((v): v is string => typeof v === 'string');
  try { const l = readLifelineIngressSecret(src.stateDir); if (l) out.push(l); } catch { /* @silent-fallback-ok — no lifeline secret on this machine */ }
  try { collectStringLeaves(new SecretStore({ stateDir: src.stateDir, forceFileKey: src.forceFileKey }).read(), out); } catch (e) { onStoreError?.(e); /* @silent-fallback-ok — no readable secret store; the shape scrub still runs and the caller records it */ }
  return out;
}

/**
 * The same values, cached for `ttlMs` (default 60 s): reading the secret store
 * may spawn a keychain helper, which must not run on every layer write. A
 * rotated value is picked up within the TTL.
 */
export function cachedLiveSecrets(src: LiveSecretSources, opts: { ttlMs?: number; now?: () => number; onStoreError?: (err: unknown) => void } = {}): () => readonly string[] {
  const ttl = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let at = -Infinity;
  let value: readonly string[] = [];
  return () => {
    if (now() - at >= ttl) { value = collectAgentLiveSecrets(src, opts.onStoreError); at = now(); }
    return value;
  };
}
