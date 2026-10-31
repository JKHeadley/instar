import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export type WindowsDesktopBootstrapPhase = 'preflight' | 'address' | 'stage' | 'update' | 'install' | 'confirm';
export interface WindowsDesktopBootstrapStatus {
  state: 'off' | 'ready' | 'install-failed';
  phase?: WindowsDesktopBootstrapPhase;
  code?: string;
}

/** Collapse a failed update handshake to a fixed, non-sensitive reason. */
export function classifyWindowsDesktopPrepareFailure(error: unknown): string {
  const value = error as { message?: unknown; name?: unknown; cause?: { code?: unknown } } | null;
  const message = typeof value?.message === 'string' ? value.message : '';
  if (message === 'companion-reply-http-403') return 'prepare-http-forbidden';
  if (message === 'companion-reply-http-404') return 'prepare-http-not-found';
  if (message.startsWith('companion-reply-http-')) return 'prepare-http-other';
  if (value?.cause?.code === 'ECONNREFUSED') return 'prepare-connect-refused';
  if (value?.cause?.code === 'ETIMEDOUT' || value?.cause?.code === 'ENETUNREACH') return 'prepare-connect-unavailable';
  if (value?.name === 'TimeoutError') return 'prepare-timeout';
  return 'prepare-reply-invalid';
}

const phases = new Set<WindowsDesktopBootstrapPhase>(['preflight', 'address', 'stage', 'update', 'install', 'confirm']);
const codes: Array<[RegExp, string]> = [
  [/Windows companion installer requires WSL/i, 'wsl-unavailable'],
  [/Packaged Windows companion source is missing/i, 'companion-source-missing'],
  [/Windows user directory unavailable/i, 'windows-user-directory-unavailable'],
  [/WSL gateway unavailable/i, 'wsl-gateway-unavailable'],
  [/WSL gateway is not private/i, 'wsl-gateway-not-private'],
  [/windows-desktop-windows-addresses-unavailable/i, 'windows-addresses-unavailable'],
  [/Windows companion stage did not confirm/i, 'stage-unconfirmed'],
  [/Running companion has no shared secret/i, 'companion-secret-missing'],
  [/Existing Windows companion secret is invalid/i, 'companion-secret-invalid'],
  [/prepare-http-forbidden/i, 'prepare-http-forbidden'],
  [/prepare-http-not-found/i, 'prepare-http-not-found'],
  [/prepare-http-other/i, 'prepare-http-other'],
  [/prepare-connect-refused/i, 'prepare-connect-refused'],
  [/prepare-connect-unavailable/i, 'prepare-connect-unavailable'],
  [/prepare-timeout/i, 'prepare-timeout'],
  [/prepare-reply-invalid/i, 'prepare-reply-invalid'],
  [/Running Windows companion did not prepare/i, 'prepare-update-failed'],
  [/Running Windows companion did not return an update token/i, 'update-token-missing'],
  [/Windows companion installer did not confirm/i, 'install-unconfirmed'],
  [/(?:Add-Type|\bCS\d{4}\b|Companion compiler produced no executable)/i, 'companion-compile-failed'],
  [/(?:Access is denied|UnauthorizedAccessException|EACCES)/i, 'windows-access-denied'],
  [/(?:Schedule\.Service|RegisterTaskDefinition|Task Scheduler service)/i, 'windows-task-scheduler-failed'],
  [/(?:spawn powershell\.exe ENOENT|powershell\.exe: not found)/i, 'powershell-unavailable'],
  [/(?:spawn wslpath ENOENT|wslpath: not found)/i, 'wslpath-unavailable'],
];
const safeCodes = new Set([...codes.map(([, code]) => code), 'installer-process-failed']);
const bootNonce = randomBytes(16).toString('hex');

/** Only fixed vocabulary leaves this parser. Installer stderr may contain paths,
 * addresses, and process output, so it must never be returned by the API. */
export function classifyWindowsDesktopBootstrapError(error: unknown): WindowsDesktopBootstrapStatus {
  const value = error as { message?: unknown; stderr?: unknown } | null;
  const message = typeof value?.message === 'string' ? value.message : '';
  const stderr = Buffer.isBuffer(value?.stderr) ? value.stderr.toString('utf8')
    : typeof value?.stderr === 'string' ? value.stderr : '';
  const output = `${stderr}\n${message}`.slice(0, 32_768);
  const phaseMatch = output.match(/instar-desktop-installer-phase:(preflight|address|stage|update|install|confirm)/);
  const phase = phaseMatch && phases.has(phaseMatch[1] as WindowsDesktopBootstrapPhase)
    ? phaseMatch[1] as WindowsDesktopBootstrapPhase : 'preflight';
  return { state: 'install-failed', phase,
    code: codes.find(([pattern]) => pattern.test(output))?.[1] ?? 'installer-process-failed' };
}

function statusPath(stateDir: string): string {
  return path.join(stateDir, 'state', 'windows-desktop-bootstrap.json');
}

export function writeWindowsDesktopBootstrapStatus(stateDir: string, status: WindowsDesktopBootstrapStatus): void {
  const destination = statusPath(stateDir);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify({ ...status, bootNonce }) + '\n', { mode: 0o600 });
}

export function readWindowsDesktopBootstrapStatus(stateDir: string): WindowsDesktopBootstrapStatus | null {
  try {
    const file = statusPath(stateDir);
    if (fs.statSync(file).size > 1_024) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as WindowsDesktopBootstrapStatus & { bootNonce?: string };
    if (parsed.bootNonce !== bootNonce) return null;
    if (parsed.state === 'off' || parsed.state === 'ready') return { state: parsed.state };
    if (parsed.state === 'install-failed'
      && parsed.phase && phases.has(parsed.phase)
      && typeof parsed.code === 'string' && safeCodes.has(parsed.code)) {
      return { state: parsed.state, phase: parsed.phase, code: parsed.code };
    }
  } catch { /* @silent-fallback-ok — absent or corrupt maintenance status only removes optional diagnosis; desktop admission stays dark. */ }
  return null;
}
