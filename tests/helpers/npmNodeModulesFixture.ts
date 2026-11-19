/**
 * Tiny npm packages in a temp dir, packed into a LOCAL npm cache, plus a
 * hand-written lockfile, so `npm ci --offline` installs them with no network
 * (spec reaper-node-modules-regenerable, Testing). Never touches the agent home
 * or the user's npm cache.
 *
 *   fixplain@1.0.0  — index.js, lib/util.js (no scripts)
 *   fixscript@1.0.0 — hasInstallScript: postinstall writes build/native.o (random
 *                     bytes, like a native build) and rewrites its bin/tool (like esbuild)
 *   fixbin@2.0.0    — a `bin` entry (npm links node_modules/.bin/fixbin)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export interface NpmFixture {
  root: string;
  cacheDir: string;
  /** Write package.json + package-lock.json for the fixture deps into `dir`. */
  writeProject(dir: string, opts?: { rootPostinstallMarker?: string; omit?: string[] }): void;
  /** `npm ci --offline` in `dir` from the local cache, install scripts RUN (a session's real install). */
  install(dir: string): void;
  env: NodeJS.ProcessEnv;
}

const PKGS: Record<string, { version: string; files: Record<string, { body: string; mode?: number }>; pkg: Record<string, unknown> }> = {
  fixplain: {
    version: '1.0.0',
    pkg: { main: 'index.js' },
    files: { 'index.js': { body: 'module.exports = require("./lib/util");\n' }, 'lib/util.js': { body: 'module.exports = 42;\n' } },
  },
  fixscript: {
    version: '1.0.0',
    pkg: { main: 'index.js', scripts: { postinstall: 'node install.js' } },
    files: {
      'index.js': { body: 'module.exports = "scripted";\n' },
      'bin/tool': { body: '#!/bin/sh\necho placeholder\n', mode: 0o755 },
      'install.js': {
        body: [
          "const fs = require('fs'); const path = require('path'); const crypto = require('crypto');",
          "fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true });",
          "fs.writeFileSync(path.join(__dirname, 'build', 'native.o'), crypto.randomBytes(64));",
          "fs.writeFileSync(path.join(__dirname, 'bin', 'tool'), '#!/bin/sh\\necho platform-binary\\n');",
          "fs.chmodSync(path.join(__dirname, 'bin', 'tool'), 0o755);",
          '',
        ].join('\n'),
      },
    },
  },
  fixbin: {
    version: '2.0.0',
    pkg: { bin: { fixbin: 'cli.js' } },
    files: { 'cli.js': { body: '#!/usr/bin/env node\nconsole.log("fixbin");\n', mode: 0o755 } },
  },
};

export function makeNpmFixture(root: string): NpmFixture {
  const cacheDir = path.join(root, 'npm-cache');
  const env: NodeJS.ProcessEnv = { ...process.env, npm_config_cache: cacheDir, npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
  delete env.npm_config_ignore_scripts;
  const integrity: Record<string, string> = {};
  for (const [name, def] of Object.entries(PKGS)) {
    const dir = path.join(root, 'pkgs', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: def.version, ...def.pkg }, null, 2));
    for (const [rel, f] of Object.entries(def.files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), f.body);
      if (f.mode) fs.chmodSync(path.join(dir, rel), f.mode);
    }
    const out = path.join(root, 'tarballs');
    fs.mkdirSync(out, { recursive: true });
    execFileSync('npm', ['pack', '--silent', '--pack-destination', out], { cwd: dir, env, stdio: 'pipe' });
    const tgz = path.join(out, `${name}-${def.version}.tgz`);
    integrity[name] = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(tgz)).digest('base64')}`;
    execFileSync('npm', ['cache', 'add', tgz, '--cache', cacheDir], { cwd: root, env, stdio: 'pipe' });
  }
  return {
    root,
    cacheDir,
    env,
    writeProject(dir, opts = {}) {
      const deps = Object.keys(PKGS).filter((n) => !(opts.omit ?? []).includes(n));
      const dependencies = Object.fromEntries(deps.map((n) => [n, PKGS[n].version]));
      const scripts = opts.rootPostinstallMarker ? { postinstall: `node -e "require('fs').writeFileSync('${opts.rootPostinstallMarker.replace(/[^A-Za-z0-9_.-]/g, '')}', 'x')"` } : undefined;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'proj', version: '0.0.0', private: true, dependencies, ...(scripts ? { scripts } : {}) }, null, 2) + '\n');
      const packages: Record<string, unknown> = { '': { name: 'proj', version: '0.0.0', dependencies, ...(scripts ? { hasInstallScript: true } : {}) } };
      for (const n of deps) {
        packages[`node_modules/${n}`] = {
          version: PKGS[n].version,
          resolved: `https://registry.npmjs.org/${n}/-/${n}-${PKGS[n].version}.tgz`,
          integrity: integrity[n],
          ...(n === 'fixscript' ? { hasInstallScript: true } : {}),
          ...(n === 'fixbin' ? { bin: { fixbin: 'cli.js' } } : {}),
        };
      }
      fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'proj', version: '0.0.0', lockfileVersion: 3, requires: true, packages }, null, 2) + '\n');
    },
    install(dir) {
      execFileSync('npm', ['ci', '--offline', '--no-audit', '--no-fund'], { cwd: dir, env, stdio: 'pipe' });
    },
  };
}
