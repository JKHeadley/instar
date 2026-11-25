#!/usr/bin/env node
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const CLAUDE_HOOK = 'bash "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/session-start.sh"';
const CODEX_SCRIPT = 'telegram-topic-context.sh';
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PACKET_CARRIER = /^packet:[a-f0-9]{8}$/;

function registeredHook(settings, event, matcher, matchesCommand, minimumTimeout) {
  return (settings?.hooks?.[event] ?? []).some(group => group.matcher === matcher &&
    (group.hooks ?? []).some(hook => hook.type === 'command' &&
      matchesCommand(hook.command) && Number.isFinite(hook.timeout) &&
      hook.timeout >= minimumTimeout));
}

function matchesCodexAck(row, marker, installedAt, now) {
  return marker?.sessionId === row.sessionId && marker.engine === 'codex-cli' &&
    marker.source === 'compact' && marker.delivery === 'next-prompt' &&
    Array.isArray(marker.epochs) && marker.epochs.some(epoch =>
      epoch.epoch === row.boundaryUuid && epoch.carrier === row.seededCarrier &&
      Number.isFinite(epoch.seededAt) && epoch.seededAt >= installedAt &&
      epoch.seededAt >= row.at && epoch.seededAt <= now);
}

export function evaluateRecovery({
  expectedVersion, machine, installedAt, now, health, sentinel,
  claudeSettings, codexSettings, claudeScriptExecutable, codexScriptExecutable,
  codexHookCommands, readMarker,
}) {
  const checks = {
    expectedRelease: health?.version === expectedVersion,
    freshSentinel: sentinel?.heartbeatFresh === true &&
      Number.isFinite(sentinel.lastTickAt) && sentinel.lastTickAt >= installedAt &&
      sentinel.lastTickAt <= now,
    claudeHook: claudeScriptExecutable && registeredHook(
      claudeSettings, 'SessionStart', 'compact', command => command === CLAUDE_HOOK, 45,
    ),
    codexHook: codexScriptExecutable && registeredHook(
      codexSettings, 'UserPromptSubmit', '',
      command => codexHookCommands.includes(command), 15_000,
    ),
  };
  const observations = { claudeCode: false, codex: false };
  if (Object.values(checks).every(Boolean)) {
    for (const row of sentinel.canary?.recent ?? []) {
      if (row.machine !== machine || row.synthetic !== false || row.recoveryBlock !== true ||
          row.recoveryTruncated === true || row.superseded === true ||
          !Number.isFinite(row.at) || row.at < installedAt || row.at > now) continue;
      if (row.engine === 'claude-code' && row.postCompact === true &&
          Number.isFinite(row.postCompactAt) && row.postCompactAt >= installedAt &&
          row.postCompactAt <= now) observations.claudeCode = true;
      if (row.engine === 'codex-cli' &&
          SESSION_ID.test(row.sessionId ?? '') && PACKET_CARRIER.test(row.seededCarrier ?? '') &&
          matchesCodexAck(row, readMarker(row.sessionId), installedAt, now)) observations.codex = true;
    }
  }
  const verified = observations.claudeCode && observations.codex;
  return {
    status: verified ? 'native-recovery-observed' : 'awaiting-evidence',
    checks,
    observations,
  };
}

const HELP = 'Usage: node scripts/verify-studio-context-recovery.mjs --project-dir PATH --machine ID --expected-version VERSION --installed-at ISO-8601';

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readOptionalJson(file) {
  try { return readJson(file); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function executable(file) {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
}

async function readStatus(port, endpoint, token) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`${endpoint} returned HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const { values } = parseArgs({ options: {
    'project-dir': { type: 'string' },
    machine: { type: 'string' },
    'expected-version': { type: 'string' },
    'installed-at': { type: 'string' },
    help: { type: 'boolean' },
  } });
  if (values.help) { process.stdout.write(HELP + '\n'); return; }
  const installedAt = Date.parse(values['installed-at'] ?? '');
  if (!values['project-dir'] || !values.machine || !values['expected-version'] ||
      !/(?:Z|[+-]\d\d:\d\d)$/.test(values['installed-at'] ?? '') ||
      !Number.isFinite(installedAt) || installedAt > Date.now()) throw new Error(HELP);
  const root = path.resolve(values['project-dir']);
  const config = readJson(path.join(root, '.instar', 'config.json'));
  const sessionRoot = process.env.INSTAR_AGENT_HOME || process.env.INSTAR_PROJECT_DIR;
  const token = typeof config.authToken === 'string' ? config.authToken :
    sessionRoot && realpathSync(sessionRoot) === realpathSync(root) ? process.env.INSTAR_AUTH_TOKEN : undefined;
  if (typeof token !== 'string' || !token || !Number.isInteger(config.port) ||
      config.port < 1 || config.port > 65535) throw new Error('Local Instar configuration is missing its port or authorization');
  const [health, sentinel] = await Promise.all([
    readStatus(config.port, '/health', token),
    readStatus(config.port, '/context-budget/sentinel', token),
  ]);
  const hooksDir = path.join(root, '.instar', 'hooks', 'instar');
  const codexScript = path.join(hooksDir, CODEX_SCRIPT);
  const codexScriptExecutable = executable(codexScript);
  const result = evaluateRecovery({
    expectedVersion: values['expected-version'],
    machine: values.machine,
    installedAt,
    now: Date.now(),
    health,
    sentinel,
    claudeSettings: readOptionalJson(path.join(root, '.claude', 'settings.json')),
    codexSettings: readOptionalJson(path.join(root, '.codex', 'hooks.json')),
    claudeScriptExecutable: executable(path.join(hooksDir, 'session-start.sh')),
    codexScriptExecutable,
    codexHookCommands: codexScriptExecutable ?
      [`bash ${codexScript}`, `bash ${realpathSync(codexScript)}`] : [],
    readMarker: sessionId => readOptionalJson(path.join(
      root, '.instar', 'state', 'context-layers', '_seeded', sessionId + '.json',
    )),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.status === 'native-recovery-observed' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    const safeMessage = err.message === HELP || /^\/[-a-z/]+ returned HTTP \d+$/.test(err.message) ||
      err.message === 'Local Instar configuration is missing its port or authorization';
    process.stderr.write((safeMessage ? err.message : 'Could not read local recovery evidence') + '\n');
    process.exitCode = 2;
  });
}
