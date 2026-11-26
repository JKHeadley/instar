#!/usr/bin/env node
/**
 * A fake interactive `claude` for the confined-reroute E2E (docs/specs/confined-spawn-subscription-reroute.md).
 * It draws the dialogs measured on Claude Code 2.1.300/2.1.303 (workspace trust, then the browser-tools
 * offer), reacts to Down/Enter like the real TUI, then shows the `dontAsk` ready prompt, reads the one
 * typed line, records its argv, its environment and that line to `<cwd>-fake-record.json` (the real
 * launch starts from `env -i`, so nothing can be passed by environment), reads the task file the line
 * names, and prints the assembled completion sentinel from its split pieces. When `<cwd>-fake-unknown`
 * exists it shows an unrecognised dialog instead and waits.
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
// The record path is derived from the cwd so the launch argv stays exactly what Instar built.
const recordPath = `${process.cwd()}-fake-record.json`;
const variant = fs.existsSync(`${process.cwd()}-fake-unknown`) ? 'unknown' : 'normal';
const cwd = process.cwd();
const record = { argv, env: { ...process.env }, typed: '', keys: [], stages: [] };
const save = () => fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
const draw = (text) => process.stdout.write(`\x1b[2J\x1b[H${text}\n`);

let stage = variant === 'unknown' ? 'unknown' : 'trust-no';
const render = () => {
  record.stages.push(stage);
  save();
  if (stage === 'unknown') return draw(' Something unexpected\n\n ❯ Maybe\n   Perhaps\n\n Enter to confirm · Esc to cancel');
  if (stage === 'trust-no' || stage === 'trust-yes') {
    const yes = stage === 'trust-yes';
    return draw(` Accessing workspace:\n\n ${cwd}\n\n Quick safety check: Is this a project you created or one you trust?\n\n Security guide\n\n ${yes ? '  No, exit' : '❯ No, exit'}\n ${yes ? '❯ Yes, I trust this folder' : '  Yes, I trust this folder'}\n\n Enter to confirm · Esc to cancel`);
  }
  if (stage === 'browser') return draw('  Claude in Chrome extension detected\n\n  ❯ No, keep browser tools off\n    Yes, use my browser\n\n  Enter to confirm · Esc to keep browser tools off');
  if (stage === 'ready') return draw(` Claude Code (fake)\n${'─'.repeat(60)}\n❯ ${record.typed}\n${'─'.repeat(60)}\n  ⏵⏵ don't ask on (shift+tab to cycle)`);
  return undefined;
};

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
render();
process.stdin.on('data', (chunk) => {
  record.keys.push(JSON.stringify(chunk));
  const enter = chunk === '\r' || chunk === '\n';
  const down = chunk === '\x1b[B' || chunk === '\x1bOB';
  if (stage === 'trust-no' && down) { stage = 'trust-yes'; return render(); }
  if (stage === 'trust-no' && enter) { process.exit(3); } // "No, exit"
  if (stage === 'trust-yes' && enter) { stage = 'browser'; return render(); }
  if (stage === 'browser' && enter) { stage = 'ready'; return render(); }
  if (stage === 'ready') {
    if (!enter) { record.typed += chunk.replace(/\x1b\[20[01]~/g, ''); return render(); }
    record.stages.push('submitted');
    save();
    const file = /Your task is in (.+)\. Read that file/.exec(record.typed)?.[1];
    const text = file ? fs.readFileSync(file, 'utf8') : '';
    const p1 = /piece 1: (\S+)/.exec(text)?.[1] ?? '';
    const p2 = /piece 2: (\S+)/.exec(text)?.[1] ?? '';
    const p3 = /piece 3: (\S+)/.exec(text)?.[1] ?? '';
    draw(`⏺ done\n${p1}${p2}${p3}\n${'─'.repeat(60)}\n❯ \n  ⏵⏵ don't ask on (shift+tab to cycle)`);
  }
  return undefined;
});
