#!/usr/bin/env node

/**
 * Publication gate for Codex Stage B. The build must carry the exact
 * Echo-signed two-hour / fifty-delivery RC evidence that every installed
 * machine will verify at startup. A missing placeholder, wrong package
 * binding, bad signature, incomplete case matrix, or non-zero failure count
 * blocks npm publication.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundledStageBReleaseEvidence,
  verifyBundledStageBReleaseEvidence,
} from '../dist/core/StageBActivationGate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const evidence = bundledStageBReleaseEvidence();
const failure = verifyBundledStageBReleaseEvidence(String(pkg.version));

if (!evidence || failure) {
  console.error(`[codex-stage-b-release] BLOCKED: ${failure ?? 'artifact-missing'}`);
  console.error('Run and approve the bounded Echo Stage-B RC canary, then embed its signed evidence before publishing.');
  process.exit(1);
}

// Code-binding spec: the certified Stage-B sources must match the manifest the
// evidence is bound to. Drift blocks publishing until a fresh canary rebinds.
const fp = spawnSync(process.execPath, [path.join(root, 'scripts', 'stage-b-certified-fingerprint.mjs'), '--check'], { stdio: 'inherit' });
if (fp.status !== 0) {
  console.error('[codex-stage-b-release] BLOCKED: certified-source drift (see above).');
  process.exit(1);
}

console.log(`[codex-stage-b-release] verified ${evidence.artifact.deliveryCount} deliveries over ${Math.floor((evidence.artifact.endedAt - evidence.artifact.startedAt) / 60_000)} minutes; signer=${evidence.artifact.echoMachineId}`);
