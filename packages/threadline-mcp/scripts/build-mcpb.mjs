#!/usr/bin/env node
// Builds threadline-<version>.mcpb, the one-click Claude Desktop extension (spec D12).
// Stages the built server (dist/), its production dependencies and the manifest, then packs
// with the official @anthropic-ai/mcpb CLI. Run from packages/threadline-mcp after `npx tsc`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
if (!fs.existsSync(path.join(pkgDir, 'dist', 'server.js'))) throw new Error('dist/server.js missing: run `npx tsc` first');

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-mcpb-'));
const server = path.join(stage, 'server');
fs.mkdirSync(server);
fs.cpSync(path.join(pkgDir, 'dist'), path.join(server, 'dist'), { recursive: true });
for (const f of ['package.json', 'package-lock.json', 'README.md']) fs.copyFileSync(path.join(pkgDir, f), path.join(server, f));
// Production dependencies only, exactly as the lockfile pins them.
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: server, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } });

const manifest = fs.readFileSync(path.join(pkgDir, 'mcpb', 'manifest.template.json'), 'utf8').replace('__VERSION__', pkg.version);
JSON.parse(manifest); // fail early on a broken template
fs.writeFileSync(path.join(stage, 'manifest.json'), manifest);

const out = path.join(pkgDir, `threadline-${pkg.version}.mcpb`);
execFileSync('npx', ['-y', '@anthropic-ai/mcpb@2.1.2', 'validate', path.join(stage, 'manifest.json')], { stdio: 'inherit' });
execFileSync('npx', ['-y', '@anthropic-ai/mcpb@2.1.2', 'pack', stage, out], { stdio: 'inherit' });
fs.rmSync(stage, { recursive: true, force: true });
console.log(`built ${out}`);
