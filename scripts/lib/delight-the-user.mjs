/**
 * delight-the-user.mjs — pure decision logic for the "Delight the User" review
 * gate in the instar-dev commit gate.
 *
 * Governed by: *Delight the User* (docs/STANDARDS-REGISTRY.md), a tree node
 * under *Operator-Surface Quality*. Spec: docs/specs/delight-the-user-standard.md.
 *
 * Operator-Surface Quality sets the floor a screen must clear: reachable, plain,
 * usable at phone width. A screen can clear all of it and still be unpleasant
 * (the 2026-11-18 Work Board card: a wall of same-size grey prose with leaked
 * ids and tiny truncated buttons). This gate makes the higher question
 * unskippable: every change to a screen a person sees must answer, in writing,
 * whether it delights, and must name the before/after screenshots it was
 * reviewed against.
 *
 * SIGNAL-FREE: these predicates never block. The gate
 * (scripts/instar-dev-precommit.js → assertDelightTheUser) reads them and
 * decides. What they check is structural presence of an attestation (a written
 * answer, named screenshot files that exist at commit time). Whether the screen
 * actually delights is a judgment, held by the change's independent review and
 * by the person — never by this file (docs/signal-vs-authority.md).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { secondPassConcurred, secondPassReviewerNamed } from './instar-dev-trace.mjs';

/**
 * A user-facing surface is a file whose change alters what a person sees:
 *   - dashboard renderers, markup, styles, images and fonts (dashboard/**), including
 *     the console the native apps embed;
 *   - the phone pairing pages (dashboard-pair/**, the same file kinds);
 *   - the public site's images and fonts (site/public/**);
 *   - the public site's pages, components, layouts and styles (site/src/{pages,
 *     components,layouts,styles}/**, astro/css/jsx/tsx) — NOT its markdown docs;
 *   - the public feedback page (feedback-front/public/**, js/html/css);
 *   - approval / operator-approval / secret-drop pages anywhere (the existing
 *     operator-surface basenames).
 * Tests, specs and markdown are never surfaces. A replaced icon or font changes
 * what a person sees as surely as a stylesheet does, so assets count.
 */
export const USER_FACING_SURFACE_RE = new RegExp(
  [
    '^dashboard\\/.+\\.(?:js|html|css|png|jpe?g|svg|webp|gif|ico|woff2?)$',
    '^dashboard-pair\\/.+\\.(?:js|html|css|png|jpe?g|svg|webp|gif|ico|woff2?)$',
    '^site\\/public\\/.+\\.(?:png|jpe?g|svg|webp|gif|ico|woff2?)$',
    '^site\\/src\\/(?:pages|components|layouts|styles)\\/.+\\.(?:astro|css|jsx|tsx)$',
    '^feedback-front\\/public\\/.+\\.(?:js|html|css)$',
    '(?:^|\\/)(?:approval|operator-approval|secret-drop)[^/]*\\.(?:js|html|ts|css)$',
  ].join('|'),
  'i',
);

/**
 * True when a staged repo-relative path is a user-facing surface.
 * @param {string} file
 * @returns {boolean}
 */
export function isUserFacingSurfaceFile(file) {
  const f = String(file ?? '');
  if (!f) return false;
  if (/\.(?:test|spec)\.(?:js|ts|mjs|tsx|jsx)$/i.test(f)) return false;
  if (/(?:^|\/)(?:__tests__|tests?)\//i.test(f)) return false;
  return USER_FACING_SURFACE_RE.test(f);
}

const IMAGE_RE = /\.(?:png|jpe?g|webp|gif|heic)$/i;
const URL_RE = /^https?:\/\/\S+$/i;

/**
 * An answer or reason must be the author's own words, not a placeholder. Its
 * adequacy is the reviewer's call; only emptiness and bare placeholders are
 * refused here (round 2 of the spec review: any fixed length floor rejects a
 * short, complete answer for a one-token CSS fix).
 */
const PLACEHOLDER_RE = /^(?:n\/?a|none|tbd|todo|nothing|same|ok(?:ay)?|x|yes|no|fine|good|done|delights?|looks? (?:good|fine)|lgtm|-+|\.+|\?+)$/i;
export function isRealReason(v) {
  const r = cleanValue(v);
  return r.length > 0 && !PLACEHOLDER_RE.test(r) && !/^\[.*\]$/.test(r);
}

/** Strip markdown emphasis / code ticks / angle brackets around a value. */
function cleanValue(v) {
  return String(v ?? '')
    .trim()
    .replace(/^[`*_<"']+|[`*_>"'.,;]+$/g, '')
    .trim();
}

/**
 * Extract the "Delight the user" section of a side-effects artifact: from a
 * heading (##, ###, ####) whose text names "delight the user" to the next
 * heading of the same or a higher level. Returns null when absent.
 * @param {string} content
 * @returns {string|null}
 */
export function extractDelightSection(content) {
  return extractSection(content, /delight the user/i);
}

/**
 * Extract the section under the first ##–#### heading whose text matches
 * `headingRe`, up to the next heading of the same or a higher level.
 * @param {string} content
 * @param {RegExp} headingRe
 * @returns {string|null}
 */
export function extractSection(content, headingRe) {
  const lines = String(content ?? '').split(/\r?\n/);
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{2,4})\s+(.*)$/);
    if (m && headingRe.test(m[2])) {
      start = i + 1;
      level = m[1].length;
      break;
    }
  }
  if (start === -1) return null;
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= level) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

/** Lines of the form "- Before: <value>" / "**After:** <value>" / "Screenshots: …". */
const FIELD_RE = /^\s*(?:[-*+]\s+)?(?:\*\*)?\s*(before|after|screenshots)\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*)$/i;

/**
 * Resolve a named screenshot path for an existence check. `~` expands to the
 * home directory; a relative path resolves against the repo root. The result
 * is normalized, so `card.png` and `./card.png` resolve to one path.
 */
function resolveShot(value, root) {
  if (value.startsWith('~/')) return path.normalize(path.join(os.homedir(), value.slice(2)));
  if (path.isAbsolute(value)) return path.normalize(value);
  return path.resolve(root || process.cwd(), value);
}

/**
 * Does the side-effects artifact answer the delight question?
 *
 * Passes only when ALL hold:
 *   1. a "Delight the user" section exists;
 *   2. EITHER a "Screenshots: no visible change — <reason>" attestation whose
 *      reason is the author's own words (not empty, not a placeholder), with no
 *      Before/After lines;
 *   3. OR one or more Before/After pairs (one pair per screen the change
 *      touches; pairs are matched in order) where:
 *        - each side names an image (png/jpg/jpeg/webp/gif/heic) path or an http(s)
 *          URL; Before may instead say "none — new screen: <reason>" and After
 *          "none — screen removed: <reason>", but not both in one pair;
 *        - the counts of Before and After lines match;
 *        - within a pair, Before and After are not literally the same: different
 *          normalized paths and, for local files, different bytes (sha256)
 *          when `fileIdentity` is supplied; links are compared as strings and
 *          never fetched. Whether two pictures differ VISIBLY is the reviewer's;
 *        - every named local file exists (when `fileExists` is supplied);
 *      AND a written answer in the author's own words outside the screenshot
 *      lines (an empty template, "n/a" or "yes" does not pass).
 *
 * Lines copied unchanged from the template's own §6c (`opts.templateText`, the
 * template file's text) are guidance, not an answer, and do not count.
 *
 * @param {string} content side-effects artifact text
 * @param {{ root?: string, fileExists?: (absPath: string) => boolean, fileIdentity?: (absPath: string) => string|null, templateText?: string }} [opts]
 * @returns {{ ok: boolean, reasons: string[], screenshots: { pairs: Array<{ before: string|null, after: string|null }>, noVisibleChange: boolean } }}
 */
export function artifactAnswersDelight(content, opts = {}) {
  const { root, fileExists, fileIdentity, templateText } = opts;
  const templateSection = templateText ? extractDelightSection(templateText) : null;
  const templateLines = new Set(
    (templateSection ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
  );
  const reasons = [];
  const screenshots = { pairs: [], noVisibleChange: false };
  const section = extractDelightSection(content);
  if (section === null) {
    return {
      ok: false,
      reasons: ['the side-effects artifact has no "Delight the user" section'],
      screenshots,
    };
  }

  const prose = [];
  const befores = [];
  const afters = [];
  let screenshotsLine = null;
  for (const raw of section.split(/\r?\n/)) {
    const line = raw.replace(/<!--.*?-->/g, '');
    // Template guidance and placeholder lines copied unchanged are neither an
    // answer nor a screenshot.
    if (templateLines.has(line.trim())) continue;
    const f = line.match(FIELD_RE);
    if (f) {
      const key = f[1].toLowerCase();
      const val = f[2].trim();
      if (key === 'before') befores.push(val);
      else if (key === 'after') afters.push(val);
      else if (screenshotsLine === null) screenshotsLine = val;
      continue;
    }
    // Bold question lines and bracketed placeholders are not an answer.
    if (/^\s*(?:\d+\.\s+)?\*\*[^*]+\?\*\*\s*$/.test(line)) continue;
    if (/^\s*\[.*\]\s*$/.test(line)) continue;
    prose.push(line);
  }

  const declaresNoVisible = !!(screenshotsLine && /^no visible change\b/i.test(cleanValue(screenshotsLine)));
  if (declaresNoVisible && (befores.length > 0 || afters.length > 0)) {
    return {
      ok: false,
      reasons: ['the section both says "no visible change" and gives Before/After pictures; keep the one that is true'],
      screenshots,
    };
  }
  const noVisible = declaresNoVisible
    && screenshotsLine.match(/^no visible change\b\s*[—–:-]*\s*(.*)$/i);
  if (noVisible) {
    screenshots.noVisibleChange = true;
    if (!isRealReason(noVisible[1])) {
      reasons.push(
        '"Screenshots: no visible change" needs a reason in your own words ' +
          '(what the change does and why nothing a person sees moves)',
      );
    }
    return { ok: reasons.length === 0, reasons, screenshots };
  }

  const answer = prose.map((l) => l.trim()).filter(Boolean).join(' ');
  if (!isRealReason(answer)) {
    reasons.push(
      'the "Delight the user" section has no written answer in your own words ' +
        '(how the screen reads at a glance: hierarchy, the one next action, spacing and type, ' +
        'no internal ids or raw formatting, polish matched across surfaces)',
    );
  }

  const checkShot = (label, value) => {
    const v = cleanValue(value);
    if (v === '') {
      reasons.push(`a "${label}:" screenshot line is empty`);
      return null;
    }
    // A new screen has no before picture; a removed screen has no after picture.
    const kind = label === 'Before' ? 'new screen' : 'screen removed';
    const nm = v.match(new RegExp(`^none\\b\\s*[—–:-]*\\s*${kind}\\b\\s*[—–:-]*\\s*(.*)$`, 'i'));
    if (nm) {
      if (!isRealReason(nm[1])) {
        reasons.push(`"${label}: none — ${kind}" needs a reason in your own words`);
      }
      return { value: 'none', abs: null };
    }
    if (URL_RE.test(v)) return { value: v, abs: null };
    if (!IMAGE_RE.test(v)) {
      reasons.push(
        `"${label}:" must name a screenshot image (png, jpg, webp, gif, heic) or an http(s) link, got "${v}"`,
      );
      return null;
    }
    const abs = resolveShot(v, root);
    if (typeof fileExists === 'function' && !fileExists(abs)) {
      reasons.push(`the "${label}:" screenshot does not exist: ${v}`);
      return { value: v, abs, id: null };
    }
    let id = null;
    if (typeof fileIdentity === 'function') {
      // Every local picture must actually open, not only exist.
      id = fileIdentity(abs);
      if (id === null) reasons.push(`the "${label}:" screenshot could not be read: ${v}`);
    }
    return { value: v, abs, id };
  };

  if (befores.length === 0) reasons.push('no "Before:" screenshot line');
  if (afters.length === 0) reasons.push('no "After:" screenshot line');
  if (befores.length && afters.length && befores.length !== afters.length) {
    reasons.push(
      `${befores.length} "Before:" line(s) but ${afters.length} "After:" line(s); ` +
        'give one Before and one After per screen the change touches',
    );
  }
  const n = Math.max(befores.length, afters.length);
  for (let i = 0; i < n; i++) {
    const b = i < befores.length ? checkShot('Before', befores[i]) : null;
    const a = i < afters.length ? checkShot('After', afters[i]) : null;
    screenshots.pairs.push({ before: b?.value ?? null, after: a?.value ?? null });
    if (b && a && b.value === 'none' && a.value === 'none') {
      reasons.push('a pair needs at least one real screenshot; "none" on both sides shows nothing');
      continue;
    }
    if (!b || !a || b.value === 'none' || a.value === 'none') continue;
    let same;
    if (b.abs && a.abs) {
      same = b.abs === a.abs || (b.id !== null && b.id !== undefined && b.id === a.id);
    } else {
      same = b.value === a.value;
    }
    if (same) {
      reasons.push('a "Before:" and its "After:" are the same picture; a review compares two different screenshots');
    }
  }
  return { ok: reasons.length === 0, reasons, screenshots };
}

/** Default filesystem check the gate passes in. */
export function defaultFileExists(abs) {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

/**
 * Default content identity: `size:sha256`, read in chunks, or null when the
 * path is not a regular file (a FIFO, a device such as /dev/zero, a directory
 * or a missing path is never opened, so it cannot hang or flood the commit).
 */
export function defaultFileIdentity(abs) {
  let fd = null;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    const hash = crypto.createHash('sha256');
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
    return `${st.size}:${hash.digest('hex')}`;
  } catch {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Has a second reviewer looked at the pictures? For a change that moves
 * something on screen, the trace must record a concurring second-pass review
 * (write-trace --second-pass true --reviewer-concurred true) AND the artifact's
 * "Second-pass review" section must name every picture it was shown (by
 * file name, the path as written when two pictures share a file name, or the
 * full link), so the review is bound to these screenshots and not to the change
 * in general. Substring matches on those names only; what the reviewer
 * concluded about the screen is theirs. The trace fields are written by the
 * committing session, the same trust model as the instar-dev second-pass phase:
 * this routes the change through a recorded review, it is not an authenticated
 * approval.
 *
 * @param {string} content side-effects artifact text
 * @param {{ secondPass?: unknown, reviewerConcurred?: unknown }} trace
 * @param {Array<{ before: string|null, after: string|null }>} pairs
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function secondPassReviewedScreenshots(content, trace, pairs) {
  const reasons = [];
  // The trace and Reviewer-line checks are the shared ones the merge-time
  // independent-review check uses, so the two can never disagree.
  if (!secondPassConcurred(trace)) {
    reasons.push(
      'no concurring second-pass review is recorded in the trace; a screen change is reviewed by a second ' +
        'reader against its Before/After pictures (write-trace --second-pass true --reviewer-concurred true)',
    );
  }
  if (!secondPassReviewerNamed(content)) {
    reasons.push('the side-effects artifact\'s "## Second-pass review" section names no **Reviewer:** (or says pending)');
  }
  const section = extractSection(content, /second[- ]pass review/i);
  if (section !== null) {
    const shots = (pairs || []).flatMap((p) => [p.before, p.after]).filter((v) => v && v !== 'none');
    const baseCount = new Map();
    for (const v of shots) {
      if (URL_RE.test(v)) continue;
      const b = path.basename(v);
      baseCount.set(b, (baseCount.get(b) ?? 0) + 1);
    }
    // A delimited reference: "card.png" inside "new-card.png" does not count.
    // (The Reviewer line is part of the section, so a name there counts too.)
    const mentions = (name, allowPathPrefix) => {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const lead = allowPathPrefix ? '(?:^|[^\\w.~-])' : '(?:^|[^\\w./~-])';
      return new RegExp(`${lead}${esc}(?![\\w/-]|\\.\\w)`).test(section);
    };
    for (const shot of shots) {
      // The path as written always counts. The bare file name counts too,
      // unless two pictures share it (before/card.png and after/card.png).
      const ambiguous = URL_RE.test(shot) || (baseCount.get(path.basename(shot)) ?? 0) > 1;
      const name = ambiguous ? shot : path.basename(shot);
      if (!mentions(shot, false) && (ambiguous || !mentions(name, true))) {
        reasons.push(`the "Second-pass review" section does not name the screenshot it reviewed: ${name}`);
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}
