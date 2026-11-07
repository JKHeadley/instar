#!/usr/bin/env node
// Account lockout safety boundary. No credential values or page text are logged.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function breakGlass(name) {
  if (/\bbreak[\s_.-]*glass\b/i.test(name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.-]/g, ' '))) return true;
  return /(?:recover(?:y)?|back[\s_.-]*up|break[\s_.-]*glass)[\s_.-]*(?:\w+[\s_.-]+){0,2}codes?\b/i.test(name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.-]/g, ' '));
}
// Self-contained: also serialized into Chrome's isolated-world evaluation.
function warning(text) {
  const t = String(text).replace(/\s+/g, ' ');
  return /\b(?:account|publishing|publish|access)\b.{0,100}\b(?:(?:suspend(?:ed)?|suspension)|lock(?:ed|out|ing)?|hold)\b/i.test(t)
    || /\b(?:(?:suspend(?:ed)?|suspension)|lock(?:ed|out|ing)?|hold)\b.{0,100}\b(?:account|publishing|publish|access)\b/i.test(t)
    || /\b(?:use|using|enter|provide|submit|redeem)\b.{0,45}\b(?:recovery|back[ -]?up|break[ -]?glass)\s+codes?\b/i.test(t)
    || /\b(?:disable|disabling|turn(?:ing)? off|remove)\b.{0,35}\b(?:two[ -]factor|2fa|multi[ -]factor)\b/i.test(t);
}
function readOnly(code) {
  const c = code.trim().replace(/^R\s*=\s*/, '').replace(/;$/, '');
  const stringsRemoved = c.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  // Writes, statements, computed invocation and arbitrary callees never earn a read exemption.
  if (/[;{}\x60]|\+\+|--|(?:^|[^=!<>])=(?!=|>)|\b(?:new|delete|await|yield|throw)\b/.test(stringsRemoved)) return false;
  if (/\]\s*\(|\)\s*\(/.test(stringsRemoved)) return false;
  const methods = new Set(['querySelector', 'querySelectorAll', 'getElementById', 'getAttribute', 'getBoundingClientRect', 'getComputedStyle', 'stringify', 'from', 'isArray', 'map', 'filter', 'find', 'some', 'every', 'slice', 'join', 'includes', 'startsWith', 'endsWith', 'trim', 'toLowerCase', 'toUpperCase', 'String', 'Number', 'Boolean']);
  for (const hit of stringsRemoved.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) if (!methods.has(hit[1])) return false;
  // Restrict property reads too: a callback such as `.map(location.assign)` is an action.
  const props = new Set([...methods, 'document', 'body', 'documentElement', 'location', 'innerText', 'textContent', 'title', 'href', 'origin', 'host', 'pathname', 'length', 'value', 'checked', 'disabled', 'tagName', 'id', 'className', 'name', 'type', 'placeholder', 'outerHTML', 'innerHTML', 'dataset', 'x', 'y', 'width', 'height', 'top', 'left', 'bottom', 'right']);
  for (const hit of stringsRemoved.matchAll(/\.\s*([A-Za-z_$][\w$]*)/g)) if (!props.has(hit[1])) return false;
  if (/\[(?!\s*\d+\s*\])/.test(stringsRemoved.replace(/\[\s*\.\.\./g, ''))) return false;
  const locals = new Set();
  for (const hit of stringsRemoved.matchAll(/(?:\b([A-Za-z_$][\w$]*)|\(([^()]*)\))\s*=>/g)) {
    for (const name of (hit[1] || hit[2]).split(',')) if (/^[A-Za-z_$][\w$]*$/.test(name.trim())) locals.add(name.trim());
  }
  const roots = new Set(['document', 'window', 'location', 'JSON', 'Array', 'String', 'Number', 'Boolean', 'getComputedStyle', 'undefined', 'null', 'true', 'false', ...locals]);
  const identifiers = stringsRemoved.replace(/\.\s*[A-Za-z_$][\w$]*/g, '');
  for (const hit of identifiers.matchAll(/[A-Za-z_$][\w$]*/g)) if (!roots.has(hit[0])) return false;
  return /\b(?:document|location)\b/.test(stringsRemoved) && !/\b(?:eval|Function|globalThis|fetch|XMLHttpRequest|setTimeout|setInterval|dispatchEvent)\b/.test(stringsRemoved);
}

function action(tool, target, code, origin = '') {
  return crypto.createHash('sha256').update(JSON.stringify([tool, target, code, origin])).digest('hex');
}
async function api(home, route, body) {
  const config = JSON.parse(fs.readFileSync(path.join(home, '.instar/config.json'), 'utf8'));
  let token = config.authToken;
  if (typeof token !== 'string') token = execFileSync(process.execPath, [path.join(home, '.instar/scripts/secret-get.mjs'), 'authToken'], { cwd: home, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const r = await fetch(`http://127.0.0.1:${config.port ?? 4040}/lockout/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error('ERR lockout-approval-refused: approval missing, expired, used, or for another action');
  return r.json();
}
async function authorize(home, digest, id) {
  if (id) { await api(home, 'consume', { id, action: digest }); return true; }
  const request = await api(home, 'request', { action: digest });
  throw new Error(`ERR lockout-guard: operator approval required for this one action. Open ${request.url}; then pass --operator-approval=${request.id} (browser: INSTAR_OPERATOR_APPROVAL=${request.id}).`);
}
function mainWorldEnvelope(code, key, tag) {
  const metadata = Buffer.from(JSON.stringify({ code, key, tag })).toString('base64url');
  const body = `(function(){try{var R="";${code}\n;document.body.dataset.${key}=${JSON.stringify(tag + 'ok:')}+String(R)}catch(e){document.body.dataset.${key}=${JSON.stringify(tag + 'err:')}+e}})()`;
  return `/*instar-mainworld:${metadata}*/delete document.body.dataset.${key}; var s=document.createElement("script"); s.textContent=${JSON.stringify(body)}; (document.head||document.documentElement).appendChild(s); s.remove(); var v=document.body.dataset.${key}; delete document.body.dataset.${key}; v===undefined ? ${JSON.stringify(tag + 'did-not-run')} : v`;
}
function unwrapMainWorld(code) {
  const match = code.match(/^\/\*instar-mainworld:([A-Za-z0-9_-]+)\*\//);
  if (!match) return null;
  try {
    const m = JSON.parse(Buffer.from(match[1], 'base64url').toString());
    if (!/^mw[a-f0-9]{12}$/.test(m.key) || !/^mw[a-f0-9]{16}$/.test(m.tag) || typeof m.code !== 'string') return null;
    return mainWorldEnvelope(m.code, m.key, m.tag) === code ? m.code : null;
  } catch { return null; }
}
async function main(args) {
  const [mode, home, callerTool, target, suppliedCode = '', origin = ''] = args;
  const original = mode === 'wrap' ? unwrapMainWorld(suppliedCode) : null;
  const tool = original === null ? callerTool : 'chrome-mainworld.sh';
  const code = original === null ? suppliedCode : original;
  const evalCode = suppliedCode;
  const id = process.env.INSTAR_OPERATOR_APPROVAL || '';
  const digest = action(tool, target, code, origin);
  if (mode === 'mainworld') {
    console.log(mainWorldEnvelope(code, 'mw' + crypto.randomBytes(6).toString('hex'), process.env.MWTAG));
  } else if (mode === 'wrap') {
    let approved = false;
    if (id) approved = await authorize(home, digest, id);
    // Full visible text is read immediately before eval in the SAME browser task.
    // A refusal is a thrown exception, never an instruction the caller must remember.
    console.log(`(()=>{if(!${readOnly(code)}){const t=document.body?.innerText;if(typeof t!=="string")throw Error("ERR lockout-guard: full page text unavailable");if(!${approved} && (${warning.toString()})(t))throw Error("ERR lockout-guard: account warning; operator approval required for action ${digest}")}return eval(${JSON.stringify(evalCode)})})()`);
  } else if (mode === 'credential') {
    if (breakGlass(target)) await authorize(home, digest, id);
  } else if (mode === 'page') {
    const text = fs.readFileSync(0, 'utf8');
    if (warning(text) || id) await authorize(home, digest, id);
  } else if (mode === 'request') {
    console.log(JSON.stringify(await api(home, 'request', { action: target })));
  } else throw Error('ERR lockout-guard: invalid mode');
}
module.exports = { breakGlass, warning, readOnly, action, mainWorldEnvelope, unwrapMainWorld, main };
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(e.message.startsWith('ERR') ? e.message : 'ERR lockout-guard: approval service unavailable; action refused'); process.exitCode = 1; });
