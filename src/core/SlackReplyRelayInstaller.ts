import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PRIOR_SHIPPED_SLACK_RELAY_SHA256 = new Set([
  // Every historical repository-shipped template before the session-bound
  // neutral relay (PR #1518). Append-only: hashes are overwrite authority.
  '1813442032e435e4ecbf01467510e39a33c3feb3acb1407307c5569a65f30305',
  '7cf4aa77a87030708ca118f21ee8fffb5788f70fea2c184948b5050d6405e096',
  '818feffbcfecdc55ae18b3d80923246eed0cb1b7f2de6c7360174ae74b588088',
  '9b12ceb1f68d93f001d20d00178b09d97613a29909b611ef2519af5e9ff1bd23',
  'a85cfeab0d4cd77aa78f731de4bd414d8207a33b6dbad66b3f950d8c58411c8a',
  'b0efb1df25e12c37adf56277659563c064424fc44f0edb32fe42756d2b93e5c0',
  'e9270f267d896ad0d7763f5927da074aee0df2dd5610d3c4ccd2bc017fc0288b',
  'ea698ef54e0e48233d82225c6cfcf886f58c7939101d966cfafc5e85edcac6a4',
]);

export interface SlackRelayInstallResult {
  installed: string[];
  current: string[];
  degraded: string[];
  errors: string[];
}

export function slackReplyRelayReadiness(stateDir: string, expectedTemplate: string): { ready: true } | { ready: false; reason: string } {
  const destination = path.join(stateDir, 'scripts', 'slack-reply.sh');
  try {
    const stat = fs.lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink()) return { ready: false, reason: 'canonical relay is not a regular non-symlink file' };
    if ((stat.mode & 0o111) === 0) return { ready: false, reason: 'canonical relay is not executable' };
    if (sha(fs.readFileSync(destination, 'utf8')) !== sha(expectedTemplate)) return { ready: false, reason: 'canonical relay bytes do not match the packaged template' };
    return { ready: true };
  } catch (err) {
    return { ready: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function isSlackConfigured(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const messaging = (config as { messaging?: unknown }).messaging;
  return Array.isArray(messaging)
    && messaging.some((entry) => !!entry && typeof entry === 'object'
      && (entry as { type?: unknown }).type === 'slack'
      && (entry as { enabled?: unknown }).enabled !== false);
}

function sha(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function atomicInstall(destination: string, content: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tmp = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o755);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fchmodSync(fd, 0o755);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, destination);
}

function reconcile(destination: string, content: string, result: SlackRelayInstallResult): void {
  const label = destination;
  try {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(destination);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      atomicInstall(destination, content);
      result.installed.push(label);
      return;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      result.errors.push(`${label}: destination is not a regular non-symlink file`);
      return;
    }
    const existing = fs.readFileSync(destination, 'utf8');
    const existingSha = sha(existing);
    const currentSha = sha(content);
    if (existingSha === currentSha) {
      if ((stat.mode & 0o777) !== 0o755) fs.chmodSync(destination, 0o755);
      result.current.push(label);
      return;
    }
    if (PRIOR_SHIPPED_SLACK_RELAY_SHA256.has(existingSha)) {
      fs.copyFileSync(destination, `${destination}.bak.${existingSha.slice(0, 12)}`);
      atomicInstall(destination, content);
      result.installed.push(label);
      return;
    }
    const candidate = `${destination}.new`;
    atomicInstall(candidate, content);
    result.degraded.push(`${label}: customized content preserved; current candidate written to ${candidate}`);
  } catch (err) {
    result.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function ensureSlackReplyRelay(params: {
  projectDir: string;
  stateDir: string;
  config: unknown;
  template: string;
  claudeCompatibility?: boolean;
}): SlackRelayInstallResult {
  const result: SlackRelayInstallResult = { installed: [], current: [], degraded: [], errors: [] };
  if (!isSlackConfigured(params.config)) return result;
  reconcile(path.join(params.stateDir, 'scripts', 'slack-reply.sh'), params.template, result);
  if (params.claudeCompatibility !== false) {
    reconcile(path.join(params.projectDir, '.claude', 'scripts', 'slack-reply.sh'), params.template, result);
  }
  return result;
}
