/**
 * Tier-1 tests for relay state on GET /threadline/health.
 *
 * WHY: until 2026-07-30 the handler returned `status: 'ok'` as a LITERAL and never
 * consulted the relay at all. On that day the relay was displaced at 04:56:12Z and
 * stayed dark for 6h45m — reconnect disarmed for the process lifetime — while this
 * route reported "ok" throughout and 131 agent-to-agent messages queued unsent.
 * Every input needed was already in-process; nothing asked for it.
 *
 * Both sides of every boundary, because the failure this closes was a check that
 * could only ever return one answer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import request from 'supertest';
import { HandshakeManager } from '../../../src/threadline/HandshakeManager.js';
import {
  createThreadlineRoutes,
  resolveRelayHealth,
  type ThreadlineEndpointsConfig,
} from '../../../src/threadline/ThreadlineEndpoints.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

type RelayStatus = ThreadlineEndpointsConfig['relayStatus'];

const lossEvent = (terminal: boolean, ts = '2026-07-30T04:56:12.879Z') => ({
  event: terminal ? 'displaced' : 'disconnected',
  ts,
  terminal,
});

describe('resolveRelayHealth', () => {
  it('reports not-configured (ok) when no probe is wired — relay disabled is NOT a fault', () => {
    const r = resolveRelayHealth(undefined);
    expect(r.status).toBe('ok');
    expect(r.report.state).toBe('not-configured');
  });

  it('reports not-configured (ok) when the probe returns null — the daemon owns the relay', () => {
    const r = resolveRelayHealth((() => null) as RelayStatus);
    expect(r.status).toBe('ok');
    expect(r.report.state).toBe('not-configured');
  });

  it('reports connected (ok) when the relay is up', () => {
    const r = resolveRelayHealth((() => ({ connectionState: 'connected', lastEvent: null })) as RelayStatus);
    expect(r.status).toBe('ok');
    expect(r.report.state).toBe('connected');
    expect(r.report.recoverable).toBe(true);
  });

  it('reports disconnected as DEGRADED and recoverable — backoff will retry', () => {
    const r = resolveRelayHealth((() => ({
      connectionState: 'disconnected',
      lastEvent: lossEvent(false),
    })) as RelayStatus);
    expect(r.status).toBe('degraded');
    expect(r.report.state).toBe('disconnected');
    expect(r.report.recoverable).toBe(true);
    expect(r.report.since).toBe('2026-07-30T04:56:12.879Z');
  });

  it('reports displaced as ERROR and NOT recoverable — reconnect is disarmed for the process lifetime', () => {
    // The distinction that matters. A displaced relay never self-heals, so
    // reporting it identically to an ordinary drop would understate a permanent
    // outage as a transient blip — exactly the 6h45m failure.
    const r = resolveRelayHealth((() => ({
      connectionState: 'disconnected',
      lastEvent: lossEvent(true),
    })) as RelayStatus);
    expect(r.status).toBe('error');
    expect(r.report.state).toBe('displaced');
    expect(r.report.recoverable).toBe(false);
    expect(r.report.since).toBe('2026-07-30T04:56:12.879Z');
  });

  it('distinguishes never-connected from disconnected — "not yet" is not "broken"', () => {
    const r = resolveRelayHealth((() => ({ connectionState: 'connecting', lastEvent: null })) as RelayStatus);
    expect(r.status).toBe('degraded');
    expect(r.report.state).toBe('never-connected');
    expect(r.report.since).toBeUndefined();
  });

  it('lets a LIVE connection win over a stale terminal event — never cries wolf', () => {
    // A reconnect in a later process leaves an older displaced entry readable.
    // Live state must take precedence, because the safe direction for a status
    // surface is refusing to report a fault that is not currently happening.
    const r = resolveRelayHealth((() => ({
      connectionState: 'connected',
      lastEvent: lossEvent(true),
    })) as RelayStatus);
    expect(r.status).toBe('ok');
    expect(r.report.state).toBe('connected');
  });

  it('degrades to not-configured when the probe THROWS — the discovery endpoint must keep answering', () => {
    const r = resolveRelayHealth((() => {
      throw new Error('relay client exploded');
    }) as RelayStatus);
    expect(r.status).toBe('ok');
    expect(r.report.state).toBe('not-configured');
  });

  it('never leaks the relay reason string — /threadline/health is unauthenticated', () => {
    const r = resolveRelayHealth((() => ({
      connectionState: 'disconnected',
      // A real payload carries peer-influenced text. It must not cross this
      // boundary; only a code-defined state, a boolean and a timestamp do.
      lastEvent: { ...lossEvent(true), reason: 'Displaced by new connection SECRET-abc' },
    })) as RelayStatus);
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain('SECRET-abc');
    expect(serialized).not.toContain('reason');
  });
});

describe('GET /threadline/health — relay reporting', () => {
  let tmpDir: string;
  let stateDir: string;
  let manager: HandshakeManager;

  const appWith = (relayStatus?: RelayStatus): express.Express => {
    const app = express();
    app.use(express.json());
    app.use(createThreadlineRoutes(manager, null, {
      localAgent: 'agent-a',
      version: '1.0',
      stateDir,
      relayStatus,
    }));
    return app;
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-health-relay-'));
    stateDir = path.join(tmpDir, 'agent-a');
    manager = new HandshakeManager(stateDir, 'agent-a');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/threadline/threadline-health-relay-state.test.ts',
    });
  });

  it('preserves the legacy ok shape when no relay is wired', async () => {
    const res = await request(appWith()).get('/threadline/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.relay.state).toBe('not-configured');
  });

  it('stops reporting ok while the relay is displaced', async () => {
    const res = await request(appWith((() => ({
      connectionState: 'disconnected',
      lastEvent: lossEvent(true),
    })) as RelayStatus)).get('/threadline/health');
    expect(res.body.status).toBe('error');
    expect(res.body.relay.state).toBe('displaced');
    expect(res.body.relay.recoverable).toBe(false);
  });

  it('keeps HTTP 200 and the discovery fields even when the relay is down', async () => {
    // AgentDiscovery.verifyAgent gates on response.ok + identityPub + protocol and
    // NEVER on `status`. If a degraded relay changed those, peers would silently
    // drop this agent from their registries — a far worse failure than the one
    // being fixed. This test pins the contract.
    const res = await request(appWith((() => ({
      connectionState: 'disconnected',
      lastEvent: lossEvent(true),
    })) as RelayStatus)).get('/threadline/health');
    expect(res.status).toBe(200);
    expect(res.body.protocol).toBe('threadline');
    expect(res.body).toHaveProperty('identityPub');
    expect(res.body.status).not.toBe('ok');
  });

  it('reports ok again once the relay is connected', async () => {
    const res = await request(appWith((() => ({
      connectionState: 'connected',
      lastEvent: null,
    })) as RelayStatus)).get('/threadline/health');
    expect(res.body.status).toBe('ok');
    expect(res.body.relay.state).toBe('connected');
  });
});
