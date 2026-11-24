#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sources = ['open-projects', 'open-specs', 'open-prs', 'recently-merged-prs', 'project-registry'];
const decisions = new Set(['reuse', 'extend', 'set-aside']);
const fills = (value) => typeof value === 'string' && value.trim().length > 0;
const strings = (value) => Array.isArray(value) && value.every(fills);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const locator = (value) => typeof value === 'string' && /^(?:repo:|evidence:|https:\/\/)[^\s]+$/.test(value);

export function relatedWorkBody(markdown) {
  return markdown.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '');
}

export function reviewDigest(markdown) {
  return createHash('sha256').update(relatedWorkBody(markdown)).digest('hex');
}

function validateEvidence(value) {
  if (!record(value) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value.observedAt ?? '') ||
      !Number.isFinite(Date.parse(value.observedAt)) || !strings(value.paths) || !strings(value.keywords) ||
      !(value.paths.length || value.keywords.length || fills(value.semanticScope)) ||
      !Number.isFinite(value.mergedLookbackHours) || value.mergedLookbackHours <= 0 || !record(value.sources) ||
      Object.keys(value.sources).length !== sources.length) {
    return 'Record the search time, scope, merged lookback and all five sources.';
  }
  for (const name of sources) {
    const row = value.sources[name];
    if (!record(row) || !['checked', 'partial'].includes(row.coverage) || !fills(row.evidence) ||
        !locator(row.locator) || (row.coverage === 'partial' && !fills(row.limit)) ||
        !Array.isArray(row.matches) || row.matchCount !== row.matches.length) {
      return `Complete the evidence, coverage, locator and match count for ${name}.`;
    }
    for (const match of row.matches) {
      if (!record(match)) return `Record each match and its disposition for ${name}.`;
      if (Object.hasOwn(match, 'restrictedDispositionRef')) {
        if (row.coverage === 'partial' && Object.keys(match).length === 1 &&
            locator(match.restrictedDispositionRef) && match.restrictedDispositionRef.startsWith('evidence:')) continue;
      } else if (fills(match.ref) && decisions.has(match.decision) && fills(match.reason)) {
        continue;
      }
      return `Record a reference, reuse/extend/set-aside decision and reason for each ${name} match.`;
    }
  }
  return null;
}

export function validateRelatedWork(markdown) {
  const lines = relatedWorkBody(markdown).split('\n');
  const headings = [];
  let fence;
  let comment = false;
  for (const [index, line] of lines.entries()) {
    if (!fence && (comment || line.includes('<!--'))) {
      comment = !line.includes('-->') || line.lastIndexOf('<!--') > line.lastIndexOf('-->');
      continue;
    }
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (fence[0] === marker[1][0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (!fence && /^ {0,3}##[ \t]+Related work[ \t]*$/i.test(line)) headings.push(index);
  }
  if (headings.length !== 1) return 'Add exactly one ## Related work heading outside examples.';
  let start = headings[0] + 1;
  while (start < lines.length && !lines[start].trim()) start++;
  if (lines[start] !== '```related-work-json') return 'Put the generated related-work-json block directly under ## Related work.';
  const end = lines.indexOf('```', start + 1);
  if (end < 0) return 'Close the related-work-json block.';
  let value;
  try {
    value = JSON.parse(lines.slice(start + 1, end).join('\n'));
  } catch {
    return 'The related-work-json block must contain valid JSON.';
  }
  return validateEvidence(value);
}

export function readRelatedWorkDigest(text) {
  const matches = [...text.matchAll(/^related-work-review-sha256:[ \t]+([a-f0-9]{64})[ \t]*$/gm)];
  return matches.length === 1 ? matches[0][1] : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [option, file, extra] = process.argv.slice(2);
    if (!file || extra || !['--evidence', '--spec'].includes(option)) {
      throw new Error('Usage: related-work-preflight.mjs --evidence evidence.json | --spec path.md');
    }
    const input = readFileSync(file, 'utf8');
    if (option === '--spec') {
      const error = validateRelatedWork(input);
      if (error) throw new Error(error);
      console.log(`related-work-review-sha256: ${reviewDigest(input)}`);
    } else {
      let evidence;
      try { evidence = JSON.parse(input); } catch { throw new Error('Evidence must be valid JSON.'); }
      const error = validateEvidence(evidence);
      if (error) throw new Error(error);
      console.log('## Related work\n\n```related-work-json\n' + JSON.stringify(evidence, null, 2) + '\n```');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
