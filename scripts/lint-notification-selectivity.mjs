#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
const root = process.cwd();
const errors = [];
const raw = {};
const trustedComposition = new Set(['src/commands/server.ts', 'src/server/routes.ts', 'src/server/notificationRoutes.ts', 'src/messaging/TelegramAdapter.ts', 'src/lifeline/TelegramLifeline.ts', 'src/messaging/telegram-origin/OriginDeterministicSend.ts', 'src/monitoring/SessionMonitor.ts']);
const contextReaders = new Set([...trustedComposition, 'src/messaging/NotificationSelectivityGate.ts', 'src/messaging/notificationStampers.ts', 'src/messaging/telegram-origin/TelegramOriginService.ts', 'src/messaging/telegram-origin/OriginBrowserExecutor.ts']);
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { scan(file); continue; }
    if (!file.endsWith('.ts')) continue;
    const rel = path.relative(root, file).replaceAll(path.sep, '/');
    const source = fs.readFileSync(file, 'utf8');
    const ast = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true);
    const boundStampers = new Set();
    function findStampers(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)
        && ['notificationStamper', 'responseNotificationStamper'].includes(node.initializer.expression.getText(ast))) boundStampers.add(node.name.text);
      ts.forEachChild(node, findStampers);
    }
    findStampers(ast);
    function fail(node, text) { errors.push(`${rel}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: ${text}`); }
    function admittedMobileMirror(node) {
      if (rel !== 'src/server/mobilePairingRoutes.ts') return false;
      for (let p = node.parent; p; p = p.parent) if (ts.isCallExpression(p) && p.expression.getText(ast) === 'router.post'
        && ts.isStringLiteral(p.arguments[0]) && p.arguments[0].text === '/mobile/chat/:topicId') return true;
      return false;
    }
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const method = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
        if (node.expression.getText(ast) === 'withNotificationEnvelope' && !trustedComposition.has(rel)) {
          const stamp = node.arguments[0];
          if (!stamp || !ts.isCallExpression(stamp) || !(boundStampers.has(stamp.expression.getText(ast)) || (admittedMobileMirror(node) && stamp.expression.getText(ast) === 'verifiedInboundMirrorEnvelope') || (rel === 'src/scheduler/JobScheduler.ts' && stamp.expression.getText(ast) === 'verifiedJobEnvelope'))) fail(node, 'producer envelopes must use their module-bound stamper; category/reply borrowing is forbidden');
        }
        if (node.expression.getText(ast).startsWith('notificationContext.') && !contextReaders.has(rel)) fail(node, 'ambient notification capability is restricted to reviewed composition seams');
        if (method === 'sendToTopic' || method === 'sendMediaToTopic') {
          const explicit = node.arguments[2] && ts.isObjectLiteralExpression(node.arguments[2]) && node.arguments[2].properties.some(p => p.name?.getText(ast) === 'envelope');
          if (explicit && !trustedComposition.has(rel)) fail(node, 'explicit notification envelopes are restricted to reviewed composition seams');
          let scoped = false;
          for (let p = node.parent; p && !ts.isSourceFile(p); p = p.parent) if (ts.isCallExpression(p) && p.expression.getText(ast) === 'withNotificationEnvelope') { scoped = true; break; }
          if (!explicit && !scoped) fail(node, 'sendToTopic requires origin-bound notification provenance');
        }
        if (method === 'apiCall' && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'sendMessage') {
          let methodName = 'unknown';
          for (let p = node.parent; p; p = p.parent) if (ts.isMethodDeclaration(p)) { methodName = p.name.getText(ast); break; }
          const key = `${rel}#${methodName}`; raw[key] = (raw[key] ?? 0) + 1;
        }
        if (node.expression.getText(ast) === 'responseNotificationStamper' && !['src/commands/server.ts', 'src/messaging/TelegramAdapter.ts', 'src/lifeline/TelegramLifeline.ts'].includes(rel)) fail(node, 'inbound response capability is restricted to explicit command and floor composition');
        if (node.expression.getText(ast) === 'notificationStamper' && node.arguments.length > 1 && !((rel === 'src/server/AgentServer.ts' && node.arguments[1]?.getText(ast) === "'spend-alert-dispatcher'") || (rel === 'src/commands/server.ts' && node.arguments[1]?.getText(ast) === "'reap-notifier'") || (rel === 'src/messaging/telegramSendSideComposition.ts' && ["'quota-notifier'", "'reap-notifier'"].includes(node.arguments[1]?.getText(ast))))) fail(node, 'named producer capability must be registered to its composition module');
        if (node.expression.getText(ast) === 'notificationStamper' && rel !== 'src/messaging/notificationStampers.ts' && node.arguments[0]?.getText(ast) !== `'${rel}'`) fail(node, 'notification stamper must be bound to its own module');
        if (node.expression.getText(ast) === 'verifiedInboundMirrorEnvelope' && !admittedMobileMirror(node)) fail(node, 'inbound mirror capability is restricted to the admitted device chat handler');
        if (node.expression.getText(ast) === 'verifiedJobEnvelope' && !['src/commands/server.ts', 'src/scheduler/JobScheduler.ts', 'src/messaging/NotificationSelectivityGate.ts', 'src/messaging/telegram-origin/TelegramOriginService.ts'].includes(rel)) fail(node, 'verified job identity may only be minted where the job itself is known');
        if (node.expression.getText(ast) === 'verifiedReplyEnvelope' && !['src/messaging/TelegramAdapter.ts', 'src/commands/server.ts', 'src/server/routes.ts', 'src/server/notificationRoutes.ts', 'src/messaging/NotificationSelectivityGate.ts', 'src/messaging/telegram-origin/TelegramOriginService.ts'].includes(rel)) fail(node, 'verified replies may only be minted by the trusted reply seam');
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
}
scan(path.join(root, 'src'));
const baselineFile = path.join(root, 'scripts', 'notification-selectivity-raw-baseline.json');
if (process.argv.includes('--write-baseline')) {
  fs.writeFileSync(baselineFile, JSON.stringify(raw, null, 2) + '\n');
} else {
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  for (const [key, count] of Object.entries(raw)) if (count > (baseline[key] ?? 0)) errors.push(`${key}: new raw Telegram send bypasses the notification funnel`);
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('Notification selectivity funnel: provenance and raw-send census verified');
