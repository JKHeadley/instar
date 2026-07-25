#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

// FD-17 read-model ratchet: this surface is advisory and must not become an
// admission, placement, or routing authority through an accidental consumer.
const root = path.resolve('src');
const offenders = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(ts|js|mjs)$/.test(entry.name)) {
      const text = fs.readFileSync(file, 'utf8');
      const authorityUse = /fetch\([^\n]*\/capability-registry|axios[^\n]*\/capability-registry|capabilityRegistry\.(admit|route|place)|capabilityRegistry\.(snapshot|classifyMachine)\s*\(/.test(text);
      const producer = file.endsWith('server/routes.ts') && /router\.get\('\/capability-registry/.test(text);
      if (authorityUse && !producer && !file.endsWith('core/CapabilityRegistry.ts')) offenders.push(file);
    }
  }
}
walk(root);
if (offenders.length) { console.error(`FD-17 capability-registry read-model consumers found:\n${offenders.join('\n')}`); process.exit(1); }
console.log('FD-17 capability-registry read-model ratchet: advisory surface has no authority consumers');
