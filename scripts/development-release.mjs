#!/usr/bin/env node
// Opt-in development distribution when the npm publishing account is unavailable.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, directory, agentHome] = process.argv.slice(2);
function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
}

if (command === 'pack' && directory && !agentHome) {
  const output = path.resolve(directory);
  fs.mkdirSync(output, { recursive: true });
  if (run('git', ['status', '--porcelain', '--untracked-files=normal']).trim()) {
    throw new Error('Development releases require a clean source revision');
  }
  const sourceSha = run('git', ['rev-parse', 'HEAD']).trim();
  const timestamp = run('git', ['show', '-s', '--format=%ct', 'HEAD']).trim();
  const packagePath = path.join(root, 'package.json');
  const original = fs.readFileSync(packagePath, 'utf8');
  const pkg = JSON.parse(original);
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Expected stable source version');
  const stable = run('npm', ['view', 'instar', 'version']).trim();
  if (pkg.version !== stable) throw new Error('Source version must equal the published stable version for safe rollback and return to stable');
  const version = `${pkg.version}-dev.${timestamp}.${sourceSha.slice(0, 12)}`;
  try {
    fs.writeFileSync(packagePath, JSON.stringify({ ...pkg, version }, null, 2) + '\n');
    // A real build is mandatory. Universal native assets preserve support on
    // both Intel and Apple Silicon; the normal release checker verifies them.
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', timeout: 600_000,
      env: { ...process.env, INSTAR_RELEASE_BUILD: '1' } });
    execFileSync(process.execPath, ['scripts/check-native-desktop-release.mjs'], { cwd: root, stdio: 'inherit' });
    const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output]))[0];
    const tarball = path.basename(packed.filename);
    const sha512 = createHash('sha512').update(fs.readFileSync(path.join(output, tarball))).digest('hex');
    fs.writeFileSync(path.join(output, 'development-release.json'), JSON.stringify({ schema: 1,
      repository: 'JKHeadley/instar', sourceSha, version, tarball, sha512 }, null, 2) + '\n');
    console.log(JSON.stringify({ version, sourceSha, output }));
  } finally {
    fs.writeFileSync(packagePath, original);
  }
} else if (command === 'install' && directory && agentHome) {
  const output = path.resolve(directory);
  const home = path.resolve(agentHome);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'development-release.json'), 'utf8'));
  if (manifest.schema !== 1 || manifest.repository !== 'JKHeadley/instar' ||
      !/^[a-f0-9]{40}$/.test(manifest.sourceSha) ||
      !/^instar-[\w.-]+\.tgz$/.test(manifest.tarball) ||
      !String(manifest.version).endsWith(`.${manifest.sourceSha.slice(0, 12)}`)) {
    throw new Error('Invalid development release manifest');
  }
  // The explicit target prevents an accidental install into the checkout.
  const config = JSON.parse(fs.readFileSync(path.join(home, '.instar/config.json'), 'utf8'));
  // Build native dependencies with the runtime that will actually boot this
  // agent, even when this installer is launched from a different checkout.
  const nodeDir = path.join(home, '.instar/bin');
  const targetNode = path.join(nodeDir, 'node');
  if (fs.existsSync(targetNode) && fs.realpathSync(targetNode) !== fs.realpathSync(process.execPath)) {
    const result = spawnSync(targetNode, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: 'inherit', env: { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  }
  // npm's env-node shebang and lifecycle children must select this same Node.
  process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`;
  const { UpdateChecker } = await import('../dist/core/UpdateChecker.js');
  const checker = new UpdateChecker({ stateDir: path.join(home, '.instar'), projectDir: home,
    port: config.port, projectName: config.projectName, hasTelegram: !!config.messaging });
  const result = await checker.applyDevelopmentArtifact({ path: path.join(output, manifest.tarball),
    version: manifest.version, sha512: manifest.sha512 });
  console.log(JSON.stringify(result, null, 2));
  if (!result.success) process.exitCode = 1;
  else console.log('Artifact installed. Request the normal session-aware server restart; do not kill active sessions.');
} else {
  console.error('Usage: node scripts/development-release.mjs pack OUTPUT_DIR\n' +
    '       node scripts/development-release.mjs install ARTIFACT_DIR AGENT_HOME');
  process.exitCode = 2;
}
