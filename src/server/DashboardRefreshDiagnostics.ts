export type DashboardRefreshFailureStage =
  | 'precondition'
  | 'broadcast'
  | 'request'
  | 'auth'
  | 'http-client';

export interface DashboardRefreshFailureBody {
  error: string;
  action: 'failed' | 'skipped';
  stage: DashboardRefreshFailureStage;
  detail: string;
  nextStep: string;
}

export function dashboardRefreshFailure(
  stage: DashboardRefreshFailureStage,
  detail: string,
  nextStep: string,
  action: 'failed' | 'skipped' = 'failed',
): DashboardRefreshFailureBody {
  return {
    error: `Dashboard refresh ${action}`,
    action,
    stage,
    detail,
    nextStep,
  };
}

export function dashboardRefreshScript(port: number): string {
  return `node --input-type=module -e "import fs from 'node:fs';
const port = process.env.INSTAR_PORT || '${port}';
const url = 'http://localhost:' + port + '/telegram/dashboard-refresh';
let auth = '';
try {
  const config = JSON.parse(fs.readFileSync('.instar/config.json', 'utf8'));
  auth = String(config.authToken || '').trim();
} catch (err) {
  console.error('[dashboard-link-refresh] failed: could not read .instar/config.json. Next step: verify the agent state directory and config JSON are present. Detail: ' + (err?.message || err));
  process.exit(2);
}
if (!auth) {
  console.error('[dashboard-link-refresh] failed: missing auth token in .instar/config.json. Next step: re-run setup or repair the agent config before refreshing the Dashboard topic.');
  process.exit(2);
}
try {
  const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + auth } });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const detail = body?.detail || body?.error || text || res.statusText;
    const nextStep = body?.nextStep || 'Check the local server health, tunnel status, and Telegram Dashboard topic configuration.';
    console.error('[dashboard-link-refresh] failed: HTTP ' + res.status + ' from ' + url + '. Detail: ' + detail + ' Next step: ' + nextStep);
    process.exit(1);
  }
  const action = body?.action || 'refreshed';
  const tunnelType = body?.tunnelType ? ' tunnelType=' + body.tunnelType : '';
  console.log('[dashboard-link-refresh] ' + action + tunnelType);
} catch (err) {
  const code = err?.code ? ' (' + err.code + ')' : '';
  console.error('[dashboard-link-refresh] failed: request to ' + url + ' could not complete' + code + '. Next step: confirm the Instar server is listening on this port and the tunnel/dashboard route is reachable. Detail: ' + (err?.message || err));
  process.exit(1);
}"`;
}

export function dashboardRefreshGateScript(port: number): string {
  return `node --input-type=module -e "const port = process.env.INSTAR_PORT || '${port}';
const url = 'http://localhost:' + port + '/health';
try {
  const res = await fetch(url);
  if (!res.ok) {
    console.error('[dashboard-link-refresh] gate failed: health returned HTTP ' + res.status + '. Next step: confirm the Instar server is healthy before refreshing the Dashboard topic.');
    process.exit(1);
  }
} catch (err) {
  const code = err?.code ? ' (' + err.code + ')' : '';
  console.error('[dashboard-link-refresh] gate failed: health request to ' + url + ' could not complete' + code + '. Next step: confirm the Instar server is listening on this port. Detail: ' + (err?.message || err));
  process.exit(1);
}"`;
}
