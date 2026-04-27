#!/usr/bin/env node
/**
 * run-migration.js — codemod for commitment://incremental-migration.
 *
 * Replaces marked direct destructive callsites with SafeFsExecutor /
 * SafeGitExecutor equivalents. Runs in idempotent passes; safe to re-run.
 *
 * Usage:
 *   node scripts/run-migration.js [--dry-run] [--filter <regex>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const filterIdx = args.indexOf('--filter');
const FILTER = filterIdx >= 0 ? new RegExp(args[filterIdx + 1]) : null;

const MARKER_RE = /^\s*\/\/\s*safe-git-allow:\s*incremental-migration\s*$/;

function listMarkedFiles() {
  const out = execSync(
    `grep -rln "safe-git-allow: incremental-migration" src/ scripts/ tests/`,
    { encoding: 'utf8' },
  );
  return out.split('\n').filter(Boolean).filter((f) => !FILTER || FILTER.test(f));
}

function relImport(filePath, target) {
  // target is repo-relative, e.g. "src/core/SafeFsExecutor.js"
  const fromDir = path.dirname(path.resolve(ROOT, filePath));
  const toFile = path.resolve(ROOT, target);
  let rel = path.relative(fromDir, toFile);
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel.replace(/\\/g, '/');
}

function ensureImport(content, filePath, importName, importPath) {
  // already imported?
  const importRe = new RegExp(
    `import\\s+\\{[^}]*\\b${importName}\\b[^}]*\\}\\s+from\\s+['"][^'"]*${importPath.split('/').pop()}['"]`,
  );
  if (importRe.test(content)) return content;

  const rel = relImport(filePath, importPath);
  const stmt = `import { ${importName} } from '${rel}';\n`;

  // insert after the last existing import line at the top of file.
  // Handle multi-line `import { ... } from '...';` by tracking until the
  // statement-terminating `from '...';` line.
  const lines = content.split('\n');
  let lastImportEnd = -1; // index of last LINE that ENDS an import statement
  let inImportBlock = false;
  for (let i = 0; i < Math.min(lines.length, 200); i++) {
    const ln = lines[i];
    if (!inImportBlock) {
      if (/^import\s/.test(ln)) {
        // single-line import? must contain `from '...'` and end with `;` or be self-terminating.
        if (/\bfrom\s+['"][^'"]+['"]\s*;?\s*$/.test(ln) || /^import\s+['"][^'"]+['"]\s*;?\s*$/.test(ln)) {
          lastImportEnd = i;
        } else {
          inImportBlock = true;
        }
      } else if (lastImportEnd >= 0 && ln.trim() === '') {
        // blank line after imports — keep looking for more imports though
        continue;
      } else if (lastImportEnd >= 0 && !/^import\s/.test(ln) && ln.trim() !== '') {
        // non-import content after seeing imports — stop scanning
        break;
      }
    } else {
      // inside multi-line import block — look for closing `} from '...';`
      if (/\bfrom\s+['"][^'"]+['"]\s*;?\s*$/.test(ln)) {
        inImportBlock = false;
        lastImportEnd = i;
      }
    }
  }
  if (lastImportEnd >= 0) {
    lines.splice(lastImportEnd + 1, 0, stmt.trimEnd());
    return lines.join('\n');
  }
  // No imports — add at top after any leading comments
  let i = 0;
  while (i < lines.length && (lines[i].startsWith('//') || lines[i].startsWith('/*') || lines[i].trim() === '')) i++;
  lines.splice(i, 0, stmt.trimEnd());
  return lines.join('\n');
}

// ─── Transformers ──────────────────────────────────────────────────

// Single-line transforms removed; all patterns go through the paren-balanced
// reader to handle nested calls (e.g., `fs.unlinkSync(path.join(a, b))`).
const transforms = [];

// Read a multi-line span starting at line `start` whose first line contains
// the opening `(` of a call expression. Returns {span: full text, endLine}.
// Walks until parens are balanced. Strings/comments are NOT escaped — works
// for the typical well-formed source we have.
function readBalancedCall(lines, startLine, openIdx) {
  let depth = 0;
  let started = false;
  let endLine = startLine;
  let endCol = openIdx;
  let inSingle = false, inDouble = false, inTpl = false, inLineComment = false, inBlockComment = false;
  outer: for (let i = startLine; i < lines.length; i++) {
    const ln = lines[i];
    const start = i === startLine ? openIdx : 0;
    inLineComment = false;
    for (let j = start; j < ln.length; j++) {
      const c = ln[j], n = ln[j + 1];
      if (inLineComment) break;
      if (inBlockComment) {
        if (c === '*' && n === '/') { inBlockComment = false; j++; }
        continue;
      }
      if (inSingle) { if (c === '\\') { j++; continue; } if (c === "'") inSingle = false; continue; }
      if (inDouble) { if (c === '\\') { j++; continue; } if (c === '"') inDouble = false; continue; }
      if (inTpl) { if (c === '\\') { j++; continue; } if (c === '`') inTpl = false; continue; }
      if (c === '/' && n === '/') { inLineComment = true; break; }
      if (c === '/' && n === '*') { inBlockComment = true; j++; continue; }
      if (c === "'") { inSingle = true; continue; }
      if (c === '"') { inDouble = true; continue; }
      if (c === '`') { inTpl = true; continue; }
      if (c === '(') { depth++; started = true; }
      else if (c === ')') {
        depth--;
        if (started && depth === 0) {
          endLine = i; endCol = j;
          break outer;
        }
      }
    }
  }
  if (depth !== 0) return null;
  const parts = [];
  for (let i = startLine; i <= endLine; i++) {
    if (i === startLine && i === endLine) parts.push(lines[i].slice(openIdx, endCol + 1));
    else if (i === startLine) parts.push(lines[i].slice(openIdx));
    else if (i === endLine) parts.push(lines[i].slice(0, endCol + 1));
    else parts.push(lines[i]);
  }
  return { span: parts.join('\n'), endLine, endCol };
}

// Verb classification (mirrors SafeGitExecutor)
const DESTRUCTIVE_GIT_VERBS = new Set([
  'add','am','apply','branch','checkout','cherry-pick','clean','clone','commit',
  'fetch','gc','init','merge','mv','pull','push','rebase','reset','restore',
  'revert','rm','stash','submodule','switch','tag','update-ref','worktree',
  'prune','notes','replace','filter-branch','remote','config','format-patch',
]);

// Extract verb + verb-args (raw string list) from args text like
// "['rev-parse', '--abbrev-ref', 'HEAD']". Returns {verb, verbArgs} or null.
function extractVerbFromArgs(argsText) {
  const arrMatch = argsText.match(/^\s*\[([\s\S]*)\]\s*$/);
  if (!arrMatch) return null;
  const items = splitTopArgs(arrMatch[1]);
  // Each item is the source text of an arg expression. Pick the first
  // string-literal as the verb. Skip a leading -C <dir> pair.
  let i = 0;
  if (items[i] && /^['"]-C['"]$/.test(items[i].trim())) i += 2;
  if (!items[i]) return null;
  const m = items[i].trim().match(/^['"]([^'"]+)['"]$/);
  if (!m) return null;
  const verb = m[1];
  // Build verbArgs from remaining string-literal items only (drop expressions).
  const verbArgs = [];
  for (let j = i + 1; j < items.length; j++) {
    const sm = items[j].trim().match(/^['"]([^'"]+)['"]$/);
    if (sm) verbArgs.push(sm[1]);
    else verbArgs.push(null); // expression — unknown
  }
  return { verb, verbArgs };
}

// Mirrors SafeGitExecutor.isReadOnlyShape for ambiguous verbs.
function isReadOnlyShape(verb, verbArgs) {
  switch (verb) {
    case 'branch':
      if (verbArgs.length === 0) return true;
      const destBranchFlags = new Set(['-d','-D','--delete','-m','-M','--move','-c','-C','--copy','--set-upstream-to','-u','--unset-upstream','-f','--force','--edit-description','--track','--no-track']);
      for (const a of verbArgs) {
        if (!a) continue;
        if (destBranchFlags.has(a)) return false;
        if (typeof a === 'string' && a.startsWith('--set-upstream')) return false;
        // Bare positional (not starting with '-') = create-branch = destructive.
        if (typeof a === 'string' && !a.startsWith('-')) return false;
      }
      return true;
    case 'remote':
      if (verbArgs.length === 0) return true;
      const sub = verbArgs[0];
      if (sub === '-v' || sub === '--verbose') return true;
      if (sub === 'show' || sub === 'get-url') return true;
      return false;
    case 'worktree':
      if (verbArgs.length === 0) return false;
      return verbArgs[0] === 'list';
    case 'config':
      for (const a of verbArgs) {
        if (!a) continue;
        if (a === '--get' || a === '--get-all' || a === '--get-regexp') return true;
        if (a === '--list' || a === '-l') return true;
        if (a === '--get-color' || a === '--get-colorbool' || a === '--get-urlmatch') return true;
      }
      return false;
    case 'format-patch':
      // --inline is destructive; otherwise read-only.
      for (const a of verbArgs) if (a === '--inline') return false;
      return true;
    case 'stash':
      if (verbArgs.length === 0) return false;
      const ss = verbArgs[0];
      return ss === 'list' || ss === 'show';
    default:
      return null;
  }
}

// Parse top-level args of a call. Returns array of arg-text spans.
function splitTopArgs(inner) {
  const out = [];
  let depth = 0, last = 0;
  let inS=false,inD=false,inT=false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inS) { if (c === '\\') { i++; continue; } if (c === "'") inS = false; continue; }
    if (inD) { if (c === '\\') { i++; continue; } if (c === '"') inD = false; continue; }
    if (inT) { if (c === '\\') { i++; continue; } if (c === '`') inT = false; continue; }
    if (c === "'") { inS = true; continue; }
    if (c === '"') { inD = true; continue; }
    if (c === '`') { inT = true; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(inner.slice(last, i));
      last = i + 1;
    }
  }
  if (last <= inner.length) out.push(inner.slice(last));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

// Inject `operation: '<op>'` into an options object literal text.
// If text is a `{ ... }` literal, merge. Otherwise wrap as `{ ...EXPR, operation }`.
function injectOperation(optsText, op) {
  if (!optsText) return `{ operation: ${op} }`;
  const t = optsText.trim();
  if (t.startsWith('{') && t.endsWith('}')) {
    let inner = t.slice(1, -1).trim();
    // Strip trailing comma so we don't produce ",, operation:"
    if (inner.endsWith(',')) inner = inner.slice(0, -1).trim();
    if (!inner) return `{ operation: ${op} }`;
    // already has operation? skip
    if (/\boperation\s*:/.test(inner)) return t;
    return `{ ${inner}, operation: ${op} }`;
  }
  return `{ ...${t}, operation: ${op} }`;
}

// Try to migrate a multi-line execFileSync('git', argsExpr, optsExpr?) call.
// Returns { newSpan, classifier } or null.
function migrateExecFileSyncGit(span, op) {
  // span is "(args)" starting at the open paren.
  const m = span.match(/^\(([\s\S]*)\)$/);
  if (!m) return null;
  const inner = m[1];
  const args = splitTopArgs(inner);
  if (args.length < 2) return null;
  if (!/^['"]git['"]$/.test(args[0])) return null;
  const argsExpr = args[1];
  const optsExpr = args[2] || '';
  const ext = extractVerbFromArgs(argsExpr);
  const verb = ext ? ext.verb : null;
  const verbArgs = ext ? ext.verbArgs : [];
  // Classify: read-only if (a) verb not in DESTRUCTIVE_GIT_VERBS, or
  // (b) ambiguous verb in destructive set but shape is read-only.
  let useRead = false;
  if (verb && !DESTRUCTIVE_GIT_VERBS.has(verb)) {
    useRead = true;
  } else if (verb) {
    const shape = isReadOnlyShape(verb, verbArgs);
    if (shape === true) useRead = true;
  }
  const method = useRead ? 'readSync' : 'execSync';
  // The opts must include cwd. We require operation. Don't try to extract cwd
  // separately — pass through and let SafeGitExecutor use opts.cwd.
  const newOpts = injectOperation(optsExpr, op);
  return { newSpan: `SafeGitExecutor.${method}(${argsExpr}, ${newOpts})` };
}

// Migrate a paren-balanced fs.rmSync/fs.rmdirSync span: span is "(target, opts?)".
function migrateFsRm(span, op, methodName) {
  const m = span.match(/^\(([\s\S]*)\)$/);
  if (!m) return null;
  const args = splitTopArgs(m[1]);
  if (args.length < 1) return null;
  const target = args[0];
  const opts = args[1] || '';
  const newOpts = injectOperation(opts, op);
  return { newSpan: `SafeFsExecutor.${methodName}(${target}, ${newOpts})` };
}

// Migrate fs.unlinkSync(target) span (single arg).
function migrateFsUnlink(span, op) {
  const m = span.match(/^\(([\s\S]*)\)$/);
  if (!m) return null;
  const args = splitTopArgs(m[1]);
  if (args.length < 1) return null;
  return { newSpan: `SafeFsExecutor.safeUnlinkSync(${args[0]}, { operation: ${op} })` };
}

// Try to migrate a multi-line execSync('git ...', optsExpr?) call.
function migrateExecSyncGit(span, op) {
  const m = span.match(/^\(([\s\S]*)\)$/);
  if (!m) return null;
  const inner = m[1];
  const args = splitTopArgs(inner);
  if (args.length < 1) return null;
  // First arg must be a string literal starting with `git ` or `git\n`.
  const first = args[0].trim();
  // Handle template literals separately (rare).
  let cmd;
  if (/^['"]/.test(first)) cmd = first.slice(1, -1);
  else if (first.startsWith('`')) cmd = first.slice(1, -1);
  else return null;
  if (!/^git[\s$]/.test(cmd) && cmd !== 'git') return null;
  // Tokenize the command after `git`. Naive split — works for the calls in
  // this repo (no shell quoting beyond simple strings).
  const tail = cmd.replace(/^git\s+/, '').trim();
  if (!tail) return null;
  // If tail contains `${...}` template interpolation, leave the original
  // string mostly intact and pass [tail-split-by-space] won't work cleanly.
  // For simplicity: only migrate when there's no `${`.
  if (tail.includes('${')) return null;
  const tokens = tail.split(/\s+/).filter(Boolean);
  const verbIdx = tokens[0] === '-C' ? 2 : 0;
  const verb = tokens[verbIdx];
  const verbArgs = tokens.slice(verbIdx + 1);
  let useRead = false;
  if (verb && !DESTRUCTIVE_GIT_VERBS.has(verb)) useRead = true;
  else if (verb) {
    const shape = isReadOnlyShape(verb, verbArgs);
    if (shape === true) useRead = true;
  }
  const method = useRead ? 'readSync' : 'execSync';
  const argsArrayLit = '[' + tokens.map((t) => `'${t}'`).join(', ') + ']';
  const optsExpr = args[1] || '';
  const newOpts = injectOperation(optsExpr, op);
  return { newSpan: `SafeGitExecutor.${method}(${argsArrayLit}, ${newOpts})` };
}

// ─── Process a file ────────────────────────────────────────────────

function processFile(filePath) {
  const orig = fs.readFileSync(filePath, 'utf8');
  let content = orig;
  const lines = content.split('\n');
  const out = [];
  const importsNeeded = new Set();
  let migrated = 0;
  let skipped = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (MARKER_RE.test(line) && i + 1 < lines.length) {
      const next = lines[i + 1];
      const opLabel = `'${path.relative(ROOT, filePath)}:${i + 2}'`;
      let transformed = null;
      let usedTransform = null;
      let consumedLines = 1;

      // First try single-line transforms.
      for (const t of transforms) {
        const m = next.match(t.re);
        if (m) {
          const replacement = t.apply(m, opLabel);
          transformed = next.replace(t.re, replacement);
          usedTransform = t;
          break;
        }
      }

      // If not, try multi-line patterns via paren-balanced reader.
      if (transformed === null) {
        // Each pattern: a regex that matches the FULL callable name +
        // optional whitespace + the open paren. The first capture group is
        // text to PRESERVE before the call (e.g., a non-word leading char for
        // bare forms). The whole regex match (m[0]) is the text we replace.
        const patterns = [
          { kind: 'git',         needs: 'SafeGitExecutor', re: /(^|[^.\w])(execFileSync)\s*\(/ },
          { kind: 'git',         needs: 'SafeGitExecutor', re: /(^|[^.\w])(spawnSync)\s*\(/ },
          { kind: 'git-string',  needs: 'SafeGitExecutor', re: /(^|[^.\w])(execSync)\s*\(/ },
          { kind: 'fs-rm',       needs: 'SafeFsExecutor', re: /()\b(fs\.rmSync)\s*\(/ },
          { kind: 'fs-unlink',   needs: 'SafeFsExecutor', re: /()\b(fs\.unlinkSync)\s*\(/ },
          { kind: 'fs-rmdir',    needs: 'SafeFsExecutor', re: /()\b(fs\.rmdirSync)\s*\(/ },
          { kind: 'fs-unlink',   needs: 'SafeFsExecutor', re: /()(require\s*\(\s*['"]fs['"]\s*\)\s*\.unlinkSync)\s*\(/ },
          { kind: 'fs-rm',       needs: 'SafeFsExecutor', re: /()(require\s*\(\s*['"]fs['"]\s*\)\s*\.rmSync)\s*\(/ },
          { kind: 'fs-rm',       needs: 'SafeFsExecutor', re: /(^|[^.\w])(rmSync)\s*\(/ },
          { kind: 'fs-unlink',   needs: 'SafeFsExecutor', re: /(^|[^.\w])(unlinkSync)\s*\(/ },
          { kind: 'fs-rmdir',    needs: 'SafeFsExecutor', re: /(^|[^.\w])(rmdirSync)\s*\(/ },
        ];
        for (const p of patterns) {
          const cm = next.match(p.re);
          if (!cm) continue;
          // The leading character (kept) is cm[1]; the callable head is cm[2].
          const lead = cm[1] || '';
          const callableName = cm[2];
          const callableStart = cm.index + lead.length;
          const openIdx = next.indexOf('(', callableStart + callableName.length - 1);
          if (openIdx < 0) continue;
          const balanced = readBalancedCall(lines, i + 1, openIdx);
          if (!balanced) continue;
          const span = balanced.span;
          let result = null;
          if (p.kind === 'git' || (p.name === 'spawnSync')) {
            result = migrateExecFileSyncGit(span, opLabel);
          } else if (p.kind === 'git-string') {
            result = migrateExecSyncGit(span, opLabel);
          } else if (p.kind === 'fs-rm') {
            result = migrateFsRm(span, opLabel, 'safeRmSync');
          } else if (p.kind === 'fs-unlink') {
            result = migrateFsUnlink(span, opLabel);
          } else if (p.kind === 'fs-rmdir') {
            result = migrateFsRm(span, opLabel, 'safeRmdirSync');
          }
          if (!result) continue;
          // For spawnSync the migrated form should remain spawnSync semantics
          // through SafeGitExecutor.spawn — but spawn returns ChildProcess, not
          // a SpawnSyncReturns. Fall back to: leave as spawn (SafeGitExecutor.spawn).
          // For now, treat spawnSync the same as execFileSync (they both have
          // {stdio,cwd} signatures). Callers using the return value as
          // SpawnSyncReturns will need manual fix-up.
          const firstLine = lines[i + 1];
          const prefix = firstLine.slice(0, callableStart);
          const lastLine = lines[balanced.endLine];
          const suffix = lastLine.slice(balanced.endCol + 1);
          transformed = prefix + result.newSpan + suffix;
          consumedLines = balanced.endLine - i;
          usedTransform = { needsImport: { name: p.needs, path: p.needs === 'SafeGitExecutor' ? 'src/core/SafeGitExecutor.js' : 'src/core/SafeFsExecutor.js' } };
          break;
        }
      }

      if (transformed !== null) {
        importsNeeded.add(usedTransform.needsImport);
        out.push(transformed);
        i += consumedLines;
        migrated += 1;
        continue;
      }
      // unknown pattern — keep marker + line untouched
      out.push(line);
      skipped += 1;
      continue;
    }
    out.push(line);
  }

  if (migrated === 0) return { migrated, skipped, changed: false };

  let result = out.join('\n');
  for (const imp of importsNeeded) {
    result = ensureImport(result, filePath, imp.name, imp.path);
  }
  if (result !== orig) {
    if (!DRY) fs.writeFileSync(filePath, result);
    return { migrated, skipped, changed: true };
  }
  return { migrated, skipped, changed: false };
}

// ─── Main ──────────────────────────────────────────────────────────

const files = listMarkedFiles();
console.log(`Found ${files.length} files with migration markers.`);

let totalMigrated = 0;
let totalSkipped = 0;
let totalFiles = 0;
for (const f of files) {
  try {
    const r = processFile(f);
    if (r.changed) totalFiles += 1;
    totalMigrated += r.migrated;
    totalSkipped += r.skipped;
    if (r.changed || r.skipped > 0) {
      console.log(`  ${f}: migrated=${r.migrated}, skipped=${r.skipped}`);
    }
  } catch (err) {
    console.error(`  ${f}: ERROR ${err.message}`);
  }
}
console.log(`\nTotal: migrated=${totalMigrated}, skipped=${totalSkipped}, files-changed=${totalFiles}`);
if (DRY) console.log('(dry run — no files written)');
