/**
 * `instar relay start|stop|status` — Manage the Threadline relay server.
 *
 * The relay is a standalone WebSocket server that enables agent-to-agent
 * communication. Agents connect via outbound WebSocket, authenticate with
 * Ed25519 signatures, and exchange E2E encrypted messages.
 *
 * Environment variables:
 *   RELAY_PORT        — WebSocket port (default: 8787)
 *   RELAY_HOST        — Bind address (default: 0.0.0.0)
 *   RELAY_ADMIN_KEY   — Admin API bearer token (required for admin endpoints)
 *   RELAY_ADMIN_PORT  — Admin API port (default: 9091)
 */

import pc from 'picocolors';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateProductionRecoveryAuthorities } from '../recovery/RecoveryAuthoritySetup.js';
import type { RecoveryAuthorityConfig } from '../recovery/RecoveryControlPlane.js';

export interface RelayStartOptions {
  port?: number;
  host?: string;
  adminPort?: number;
  adminKey?: string;
  foreground?: boolean;
  dataDir?: string;
}

export async function startRelay(opts: RelayStartOptions): Promise<void> {
  const port = opts.port ?? parseInt(process.env.RELAY_PORT ?? '8787', 10);
  const host = opts.host ?? process.env.RELAY_HOST ?? '0.0.0.0';
  const adminPort = opts.adminPort ?? parseInt(process.env.RELAY_ADMIN_PORT ?? '9091', 10);
  const adminKey = opts.adminKey ?? process.env.RELAY_ADMIN_KEY ?? '';

  if (!adminKey) {
    // Generate a random key if none provided
    const generatedKey = crypto.randomBytes(24).toString('base64url');
    console.log(pc.yellow('No RELAY_ADMIN_KEY set — generating a random one for this session:'));
    console.log(pc.cyan(`  RELAY_ADMIN_KEY=${generatedKey}`));
    console.log();
    console.log('Set this as an environment variable to persist it across restarts.');
    console.log();
    (opts as { adminKey: string }).adminKey = generatedKey;
  }

  const effectiveAdminKey = opts.adminKey ?? adminKey;

  // Dynamic import to avoid loading relay code at CLI startup
  const { RelayServer } = await import('../threadline/relay/RelayServer.js');
  const { AdminServer } = await import('../threadline/relay/AdminServer.js');

  console.log(pc.bold('Starting Threadline Relay...'));
  console.log();

  // Start relay server
  const authRate = parseInt(process.env.RELAY_AUTH_RATE ?? '5', 10);
  const dataDir = opts.dataDir ?? process.env.RELAY_DATA_DIR ?? './data';
  const relay = new RelayServer({
    port,
    host,
    rateLimitConfig: { authAttemptsPerMinute: authRate },
    registryDataDir: dataDir,
  });
  const recoveryFile = process.env.RELAY_RECOVERY_AUTHORITY_FILE;
  if (recoveryFile) {
    const st = fs.lstatSync(recoveryFile);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 262_144 || (st.mode & 0o077)) throw new Error('recovery-authority-file-invalid');
    const authorities = JSON.parse(fs.readFileSync(recoveryFile, 'utf8')) as Record<string, RecoveryAuthorityConfig>;
    const rootsFile=process.env.RELAY_RECOVERY_CERTIFICATION_ROOTS_FILE??fileURLToPath(new URL('../keys/instar-recovery-certification-roots.json',import.meta.url));
    if(!fs.existsSync(rootsFile))throw new Error('recovery-setup-release-root-required');
    const rootStat=fs.lstatSync(rootsFile);
    if(!rootStat.isFile()||rootStat.isSymbolicLink()||(rootStat.mode&0o022)||rootStat.size>65536)throw new Error('recovery-setup-release-root-invalid');
    const roots=JSON.parse(fs.readFileSync(rootsFile,'utf8')) as string[];
    if(!Array.isArray(roots)||roots.some(root=>typeof root!=='string'))throw new Error('recovery-setup-release-root-invalid');
    validateProductionRecoveryAuthorities(authorities,roots);
    relay.configureRecovery(new Map(Object.entries(authorities)));
  }
  await relay.start();

  const addr = relay.address!;
  console.log(pc.green(`  Relay listening on ws://${addr.host}:${addr.port}/v1/connect`));

  // Start admin server
  const admin = new AdminServer(
    { port: adminPort, host: '127.0.0.1', adminKey: effectiveAdminKey },
    {
      presence: relay.presence,
      rateLimiter: relay.rateLimiter,
      connections: relay.connections,
      abuseDetector: relay.abuseDetector,
      offlineQueue: relay.offlineQueue,
      metrics: relay.metrics,
      getUptime: () => Math.round(process.uptime()),
    },
  );
  await admin.start();

  const adminAddr = admin.address!;
  console.log(pc.green(`  Admin API on http://${adminAddr.host}:${adminAddr.port}/admin/status`));
  console.log();
  console.log(pc.dim('  Health:     ') + `http://${addr.host}:${addr.port}/health`);
  console.log(pc.dim('  Metrics:    ') + `http://${adminAddr.host}:${adminAddr.port}/admin/metrics`);
  console.log(pc.dim('  A2A Bridge: ') + `http://${addr.host}:${addr.port}/a2a/{agentId}/messages`);
  console.log();
  console.log(pc.dim('Press Ctrl+C to stop.'));

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log();
    console.log(pc.yellow(`${signal} received — shutting down...`));

    const stats = relay.metrics.getSnapshot();
    console.log(pc.dim(`  Messages routed:    ${stats.messagesRouted}`));
    console.log(pc.dim(`  Messages delivered: ${stats.messagesDelivered}`));
    console.log(pc.dim(`  Messages queued:    ${stats.messagesQueued}`));
    console.log(pc.dim(`  Connections total:  ${stats.connectionsTotal}`));
    console.log(pc.dim(`  Uptime:             ${Math.round(stats.uptimeSeconds)}s`));

    await admin.stop();
    await relay.stop();
    console.log(pc.green('Relay stopped cleanly.'));
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export async function relayStatus(opts: { port?: number }): Promise<void> {
  const port = opts.port ?? parseInt(process.env.RELAY_PORT ?? '8787', 10);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (!res.ok) {
      console.log(pc.red(`Relay returned ${res.status}`));
      process.exit(1);
    }

    const health = await res.json() as Record<string, unknown>;
    console.log(pc.bold('Threadline Relay Status'));
    console.log();
    console.log(`  Status:      ${pc.green(String(health.status))}`);
    console.log(`  Agents:      ${health.agents ?? 0}`);
    console.log(`  Connections: ${health.connections ?? 0}`);

    const queue = health.offlineQueue as Record<string, unknown>;
    if (queue) {
      console.log(`  Queue:       ${queue.totalMessages} messages for ${queue.recipientCount} recipients`);
    }

    const abuse = health.abuse as Record<string, unknown>;
    if (abuse) {
      console.log(`  Bans:        ${abuse.activeBans} active`);
    }

    const throughput = health.throughput as Record<string, unknown>;
    if (throughput) {
      console.log(`  Throughput:  ${throughput.messagesRouted} routed, ${throughput.messagesPerMinute}/min`);
    }

    const uptimeNum = typeof health.uptime === 'number' ? Math.round(health.uptime) : 0;
    console.log(`  Uptime:      ${uptimeNum}s`);
  } catch {
    console.log(pc.red(`Cannot reach relay at http://127.0.0.1:${port}/health`));
    console.log(pc.dim('Is the relay running? Start it with: instar relay start'));
    process.exit(1);
  }
}
