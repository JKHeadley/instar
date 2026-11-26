import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { CloudflareNamedProvider } from './CloudflareNamedProvider.js';
import { createDashboardRestartIngress } from './DashboardRestartIngress.js';
import type { TunnelProviderHandle } from './TunnelProvider.js';

interface ConnectorConfig {
  enabled: boolean;
  appPort: number;
  ingressPort: number;
  hostname: string;
  cloudflaredConfigFile: string;
}

function validPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

async function main(configPath: string): Promise<void> {
  if (!configPath || !isAbsolute(configPath)) throw new Error('Expected an absolute connector configuration path');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as ConnectorConfig;
  if (config?.enabled !== true) return;
  if (!validPort(config.appPort) || !validPort(config.ingressPort) || config.appPort === config.ingressPort ||
      typeof config.hostname !== 'string' || !/^[a-z0-9][a-z0-9.-]+\.[a-z0-9]+$/.test(config.hostname) ||
      typeof config.cloudflaredConfigFile !== 'string' || !isAbsolute(config.cloudflaredConfigFile)) {
    throw new Error('Invalid connector configuration');
  }

  const ingress = createDashboardRestartIngress(config.appPort);
  let connector: TunnelProviderHandle | undefined;
  let stopRequested!: () => void;
  const stopped = new Promise<void>(resolve => { stopRequested = resolve; });
  let connectorExited = false;
  process.once('SIGTERM', stopRequested);
  process.once('SIGINT', stopRequested);
  try {
    ingress.listen(config.ingressPort, '127.0.0.1');
    await once(ingress, 'listening');
    const provider = new CloudflareNamedProvider({
      hostname: config.hostname, configFile: config.cloudflaredConfigFile,
      onConfigFileExit: () => { connectorExited = true; stopRequested(); },
    });
    connector = await provider.start(config.ingressPort);
    await stopped;
    if (connectorExited) throw new Error('Cloudflare connector exited');
  } finally {
    process.off('SIGTERM', stopRequested);
    process.off('SIGINT', stopRequested);
    try { await connector?.stop(); }
    finally { if (ingress.listening) await new Promise<void>(resolve => ingress.close(() => resolve())); }
  }
}

void main(process.argv[2]).catch(() => {
  process.stderr.write('Dashboard connector failed to start or stop.\n');
  process.exitCode = 1;
});
