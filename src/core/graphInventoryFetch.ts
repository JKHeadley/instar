import { Agent, EnvHttpProxyAgent, fetch } from 'undici';

// Inventory starts allocate a snapshot slot. Avoid a stale pooled socket
// without replaying a POST whose outcome might already be committed.
const transportOptions = { pipelining: 0, allowH2: false };
let inventoryDispatcher: Agent | EnvHttpProxyAgent | undefined;

function inventoryTransport(): Agent | EnvHttpProxyAgent {
  const useEnvironmentProxy = process.env.NODE_USE_ENV_PROXY === '1'
    || process.execArgv.includes('--use-env-proxy')
    || (process.env.NODE_OPTIONS ?? '').split(/\s+/).includes('--use-env-proxy');
  return inventoryDispatcher ??= useEnvironmentProxy
    ? new EnvHttpProxyAgent(transportOptions)
    : new Agent(transportOptions);
}

export function fetchGraphInventoryStart(
  url: string | URL,
  options: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'error' },
) {
  return fetch(url, { ...options, dispatcher: inventoryTransport() });
}

export function isGraphInventoryStart(method: string, requestPath: string): boolean {
  return method === 'POST' && /^\/v1\/agents\/[^/]+\/inventory-exports$/.test(requestPath);
}
