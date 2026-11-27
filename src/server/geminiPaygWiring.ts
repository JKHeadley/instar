/**
 * geminiPaygWiring — builds the Gemini pay-per-use lane's server pieces from the money
 * layer (docs/specs/gemini-payg-metered-lane.md §1, §2, §5, §6). AgentServer calls
 * `buildGeminiPaygLane` once; everything else is late-bound closures so the lane always
 * reads CURRENT state (freeze, serving, designation), never a value captured at boot.
 *
 *   money port  — GeminiApiProvider's view of the money layer: preflight and admission
 *                 go through `meteredCallEntry` (freeze → live → caller → release state
 *                 → gate), settles through the gate. No other path reaches the gate.
 *   key reader  — the one named reader of `gemini_api_key_payg`, checked against the
 *                 committed keyGeneration in the door policy.
 *   runtime     — designation, forwarding, stop actions, lease echo.
 *   router      — POST /intelligence/gemini, /intelligence/gemini/review, GET status.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Router } from 'express';
import { SecretStore } from '../core/SecretStore.js';
import { GEMINI_PAYG_SECRET_NAME } from '../core/meteredSecrets.js';
import { admitMeteredCall, preflightMeteredCall, type MeteredCallEntryDeps } from '../core/meteredCallEntry.js';
import { MoneyGateRefusal, refusalHttpStatus, refusalPlainMessage, type MeteredSpendGate } from '../core/MeteredSpendGate.js';
import type { RoutingSpendCapsStore, MeteredCallerId } from '../core/RoutingSpendCapsStore.js';
import type { MeteredSpendLedger } from '../core/MeteredSpendLedger.js';
import { GeminiApiProvider, GeminiApiRefusal, GEMINI_API_DOOR, type GeminiMoneyPort } from '../providers/metered/gemini-api/GeminiApiProvider.js';
import { GeminiApiKeyReader } from '../providers/metered/gemini-api/geminiApiKeyReader.js';
import { GeminiApiTransport } from '../providers/metered/gemini-api/geminiApiTransport.js';
import { createGeminiPaygRoutes, type GeminiRefusalHttp } from './geminiPaygRoutes.js';
import { MeteredLaneRuntime, GEMINI_PAYG_KEY_REF, type LaneDesignation, type StopAction } from './meteredLaneRuntime.js';

export interface GeminiPaygWiringDeps {
  stateDir: string;
  selfMachineId: string;
  capsStore: () => RoutingSpendCapsStore | null;
  gate: () => MeteredSpendGate | null;
  ledger: () => MeteredSpendLedger | null;
  servingReady: () => boolean;
  /** Registered peers; null when the registry cannot be read (unknown fences). */
  peers: () => string[] | null;
  isLiveSession: (name: string) => boolean;
  /** Roots a reviewed spec may live under (agent home, cartographer root). */
  reviewRoots: () => string[];
  /**
   * One notice (security class or plain) — the caller routes it to the spend-alert voice
   * (GeminiPaygNotices). `epoch` rides the designation-conflict notice for its dedupe key.
   */
  notify?: (kind: 'designation-conflict' | 'key-in-plain-config' | 'stop-action', text: string, meta?: { epoch?: number }) => void;
  /** A gate refusal on the reserve path (the provisional-ceiling trip raises one card). */
  onRefusal?: (err: MoneyGateRefusal) => void;
  /** The holder side of `release-proof-forward` (the release-proof recorder). */
  releaseProof?: (originMachine: string, payload: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;
  /** Render the go-live plan here for a peer that asked. */
  renderSetup?: (requestedBy: string) => Promise<unknown>;
  /** Credential env var names whose VALUES are checked against prompts (exact match). */
  credentialEnv?: NodeJS.ProcessEnv;
  /** TEST-ONLY fake Google origin. */
  testOrigin?: string;
  /** TEST-ONLY vault read of one name (production reads the agent's SecretStore). */
  vaultGet?: (name: string) => unknown;
}

export interface GeminiPaygLane {
  provider: () => GeminiApiProvider | null;
  /** The ONE named reader (fingerprint and the go-live transcript scan go through it). */
  keyReader: GeminiApiKeyReader;
  runtime: MeteredLaneRuntime;
  router: Router;
  doorStatus: () => { configured: boolean; ready: boolean; reason?: string };
}

const SECRETISH_ENV = /(TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL)/i;

function leafStrings(v: unknown, out: string[]): void {
  if (typeof v === 'string') { out.push(v); return; }
  if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) leafStrings(x, out);
}

/** Exact values to keep out of prompts: every vault leaf plus credential-named env vars. */
export function collectLiveSecretValues(stateDir: string, env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  try {
    if (fs.existsSync(path.join(stateDir, 'secrets', 'config.secrets.enc'))) leafStrings(new SecretStore({ stateDir }).read(), out);
  } catch { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */
    // @silent-fallback-ok: an unreadable vault yields no vault values; the env values still
    // count, and the provider never calls Google without the reader's own successful read.
  }
  for (const [k, v] of Object.entries(env)) if (SECRETISH_ENV.test(k) && typeof v === 'string') out.push(v);
  return out.filter((s) => s.length >= 12);
}

function readDesignationFrom(caps: RoutingSpendCapsStore | null): LaneDesignation | null {
  if (!caps) return null;
  const f = caps.read();
  const g = f.goLive?.[GEMINI_API_DOOR];
  if (!g || !g.enabled) return null;
  const p = f.doorPolicy?.[GEMINI_API_DOOR];
  return {
    designatedMachineId: g.designatedMachineId,
    designationEpoch: p?.designationEpoch ?? g.epoch,
    oneKeyBacked: typeof p?.keyGeneration === 'string' && p.keyGeneration.length === 64,
    transferPending: false,
  };
}

export function buildGeminiPaygLane(d: GeminiPaygWiringDeps): GeminiPaygLane {
  const entryDeps = (): MeteredCallEntryDeps => ({
    capsStore: d.capsStore(),
    servingReady: () => d.servingReady(),
    gate: d.gate(),
  });

  const money: GeminiMoneyPort = {
    async preflight(req) {
      const pf = await preflightMeteredCall(entryDeps(), {
        door: GEMINI_API_DOOR, modelId: req.modelId, inputTokens: 0, maxOutputTokens: 1,
        component: req.component, caller: req.caller as MeteredCallerId, ...(req.callId ? { callId: req.callId } : {}),
      }, req.proofMarker ? { proofMarker: req.proofMarker } : undefined);
      if (pf.kind === 'deduped') {
        // Already admitted (and paid for): never a second call. The caller gets the state.
        throw new GeminiApiRefusal('already-admitted', `call ${req.callId} was already admitted (${pf.reservation.state})`);
      }
    },
    async reserve(req) {
      const r = await admitMeteredCall(entryDeps(), {
        door: GEMINI_API_DOOR,
        modelId: req.modelId,
        inputTokens: req.inputTokens,
        maxOutputTokens: req.maxOutputTokens,
        component: req.component,
        caller: req.caller as MeteredCallerId,
        inputTokensCounted: true,
        requestSha256: req.requestSha256,
        ...(req.callId ? { callId: req.callId } : {}),
        ...(req.run ? { run: req.run } : {}),
        ...(req.e1Slot ? { e1Pass: req.e1Slot } : {}),
      }, req.proofMarker ? { proofMarker: req.proofMarker } : undefined).catch((err: unknown) => {
        // The provisional-ceiling trip is an operator decision (§5): one card, one notice.
        if (err instanceof MoneyGateRefusal) {
          try { d.onRefusal?.(err); } catch { /* @silent-fallback-ok: the notice is signal-only; the refusal still returns */ }
        }
        throw err;
      });
      if (r.deduped) throw new GeminiApiRefusal('already-admitted', `call ${req.callId} was already admitted`);
      return { reserveId: r.reserveId, keyRef: r.keyRef, reserveUsd: r.reserveUsd, bookedInPerMtok: r.bookedInPerMtok, bookedOutPerMtok: r.bookedOutPerMtok };
    },
    async settleActual(keyRef, reserveId, usd) { await requireGate().settleActual(keyRef, reserveId, usd); },
    async settleNoCharge(keyRef, reserveId) { await requireGate().settleNoCharge(keyRef, reserveId); },
    async settleProvisional(keyRef, reserveId) { await requireGate().settleProvisional(keyRef, reserveId); },
    throughputFloorTps(modelId) {
      try { return d.capsStore()?.read().doorPolicy?.[GEMINI_API_DOOR]?.throughputFloorTps?.[modelId]; } catch { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */ return undefined; }
    },
  };
  function requireGate(): MeteredSpendGate {
    const g = d.gate();
    if (!g) throw new GeminiApiRefusal('not-live', 'the money gate is not constructed');
    return g;
  }

  const keyReader = new GeminiApiKeyReader({
    stateDir: d.stateDir,
    vaultGet: d.vaultGet ?? ((name) => new SecretStore({ stateDir: d.stateDir }).get(name)),
    expectedKeyGeneration: () => {
      try { return d.capsStore()?.read().doorPolicy?.[GEMINI_API_DOOR]?.keyGeneration ?? null; } catch { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */ return null; }
    },
    onPlainConfigCopy: () => d.notify?.('key-in-plain-config', `The Gemini pay-per-use key (${GEMINI_PAYG_SECRET_NAME}) is in .instar/config.json as plain text. Move it into the vault; until then the Gemini lane refuses to use it.`),
  });

  let provider: GeminiApiProvider | null = null;
  const getProvider = (): GeminiApiProvider | null => {
    if (!d.gate() || !d.capsStore()) return null; // money layer not constructed: no provider
    provider ??= new GeminiApiProvider({
      money,
      keyReader,
      liveSecretValues: () => collectLiveSecretValues(d.stateDir, d.credentialEnv ?? process.env),
      ...(d.testOrigin ? { transport: new GeminiApiTransport({ testOrigin: d.testOrigin }) } : {}),
    });
    return provider;
  };

  const refusalHttp = (reason: string, err: unknown): GeminiRefusalHttp | null => {
    if (!(err instanceof MoneyGateRefusal)) return null;
    return { status: refusalHttpStatus(err.reason), message: refusalPlainMessage(err.reason), extras: err.toWire() as unknown as Record<string, unknown> };
  };

  const applyStop = (action: StopAction, actor: string, params: Record<string, unknown>): void => {
    const caps = d.capsStore();
    if (!caps) throw new Error('money-layer-off');
    if (action === 'freeze') { caps.freeze(actor, GEMINI_PAYG_KEY_REF); return; }
    if (action === 'lower') { caps.lowerCaps(actor, GEMINI_PAYG_KEY_REF, { ...(params as object), door: GEMINI_API_DOOR }); return; }
    if (action === 'disable-caller') {
      const target = typeof params.caller === 'string' ? { caller: params.caller as MeteredCallerId } : { e3Component: String(params.e3Component ?? '') };
      caps.disableCaller(actor, GEMINI_API_DOOR, target);
      return;
    }
    caps.lowerShare(actor, GEMINI_API_DOOR, Number(params.e2MonthSharePct));
  };

  const runtime = new MeteredLaneRuntime({
    selfMachineId: d.selfMachineId,
    pendingStopsPath: path.join(d.stateDir, 'state', 'gemini-payg-pending-stops.json'),
    seenDesignationPath: path.join(d.stateDir, 'state', 'gemini-payg-seen-designation.json'),
    readDesignation: () => readDesignationFrom(d.capsStore()),
    peers: () => d.peers(),
    exec: { provider: getProvider, refusalHttp },
    ledgerLookup: (callId) => {
      const v = d.ledger()?.lookupCall(callId) ?? null;
      return v ? { requestSha256: v.requestSha256 ?? '', bookedUsd: v.contributionUsd } : null;
    },
    applyStop,
    ...(d.releaseProof ? { releaseProof: d.releaseProof } : {}),
    ...(d.renderSetup ? { renderSetup: d.renderSetup } : {}),
    secretNames: () => {
      // No vault at all is a real, empty answer. A vault that EXISTS but cannot be read is
      // not: it throws, so the asking holder records an error (a go-live blocker), never a
      // clean "key absent" (§4 — a precondition never passes by absence).
      if (!fs.existsSync(path.join(d.stateDir, 'secrets', 'config.secrets.enc'))) return [];
      const out: string[] = [];
      const walk = (o: Record<string, unknown>, p: string) => { for (const [k, v] of Object.entries(o)) { const n = p ? `${p}.${k}` : k; if (v && typeof v === 'object' && !Array.isArray(v)) walk(v as Record<string, unknown>, n); else out.push(n); } };
      walk(new SecretStore({ stateDir: d.stateDir }).read() as Record<string, unknown>, '');
      return out;
    },
    onConflict: (claim) => {
      try { d.capsStore()?.freeze('designation-conflict', GEMINI_PAYG_KEY_REF); } catch { /* @silent-fallback-ok: the gate's lease fence still refuses */ }
      d.notify?.('designation-conflict', `Gemini spending stopped on this machine: machine ${claim.machineId} claims the Gemini lane with a newer designation (epoch ${claim.designationEpoch}). Only one machine may spend.`, { epoch: claim.designationEpoch });
    },
  });

  const doorStatus = () => {
    let configured = false;
    try { configured = !!d.capsStore()?.read().goLive?.[GEMINI_API_DOOR]; } catch { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */ configured = false; }
    if (!configured) {
      // A non-holder has no caps record; it is configured when it has heard a designation.
      configured = runtime.holder() !== null;
    }
    if (!configured) return { configured: false, ready: false, reason: 'not-configured' };
    if (runtime.isDesignatedHere()) {
      const ready = d.servingReady() && getProvider() !== null;
      return { configured: true, ready, ...(ready ? {} : { reason: 'money-layer-not-serving' }) };
    }
    return { configured: true, ready: runtime.holder() !== null, ...(runtime.holder() ? {} : { reason: 'holder-unknown' }) };
  };

  const router = createGeminiPaygRoutes({
    provider: getProvider,
    isDesignatedHere: () => runtime.isDesignatedHere(),
    isLiveSession: d.isLiveSession,
    refusalHttp,
    reviewRoots: d.reviewRoots,
    doorStatus,
    forward: (c) => runtime.forwardSecondOpinion(c),
    forwardReview: (r) => runtime.forwardReview(r),
  });

  return { provider: getProvider, keyReader, runtime, router, doorStatus };
}
