#!/usr/bin/env node
/**
 * Minimal relay entrypoint for Docker/Fly.io deployment.
 * Bypasses the CLI which checks for tmux and other local prerequisites.
 */

import { startRelay } from '../dist/commands/relay.js';

const port = parseInt(process.env.RELAY_PORT ?? '8787', 10);
const host = process.env.RELAY_HOST ?? '0.0.0.0';
const adminPort = parseInt(process.env.RELAY_ADMIN_PORT ?? '9091', 10);
const adminKey = process.env.RELAY_ADMIN_KEY ?? '';
const dataDir = process.env.RELAY_DATA_DIR ?? './data';

const authRate = process.env.RELAY_AUTH_RATE ?? 'not set';
console.log(`  RELAY_AUTH_RATE: ${authRate}`);
console.log(`  RELAY_DATA_DIR: ${dataDir}`);
startRelay({ port, host, adminPort, adminKey, dataDir, foreground: true });
