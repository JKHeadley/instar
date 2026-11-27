/**
 * Private content viewer for Instar agents.
 *
 * Stores markdown content locally and serves it as rendered HTML
 * via the agent's HTTP server. When combined with a Cloudflare Tunnel,
 * this provides authenticated access to rendered content from anywhere.
 *
 * Unlike Telegraph (public), private views are gated by the agent's
 * auth token and only accessible through the tunnel URL.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { marked } from 'marked';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

// ── Types ──────────────────────────────────────────────────────────

/** The PIN page's notice under the /view sandbox (dashboard-conversations-browser-device §4.12). */
export const VIEW_PIN_NOTICE = 'This view is protected by a PIN. Unlocking protected views isn\'t available at this address right now.';

export interface PrivateViewMetadata {
  /** Source that created this view (e.g. { type: 'job', id: 'coherence-audit' }) */
  source?: { type: string; id: string };
  /** Arbitrary key-value pairs for linking views to originating contexts */
  [key: string]: unknown;
}

export interface PrivateView {
  id: string;
  title: string;
  markdown: string;
  /** SHA-256 hash of the PIN, if PIN-protected */
  pinHash?: string;
  createdAt: string;
  updatedAt?: string;
  /** Optional metadata for linking views to jobs, features, etc. */
  metadata?: PrivateViewMetadata;
}

export interface PrivateViewerConfig {
  /** Directory to store views */
  viewsDir: string;
}

/**
 * Thrown by `create` while documents replace read-only pages on this agent (the old-link
 * guarantee, docs/specs/instar-document-viewer.md §3.9b). Existing views are still served; new
 * pages and rewrites of existing ones are refused, so all new readable content is a document.
 */
export class ViewsReplacedByDocumentsError extends Error {
  readonly code = 'documents-replace-views';
  constructor() {
    super('Documents are on for this agent: new read-only pages are not made. Make a document instead (POST /docs). Links to existing pages keep working.');
    this.name = 'ViewsReplacedByDocumentsError';
  }
}

/**
 * `noDocumentHome`: the caller has nowhere a document could live (a session in a Slack channel,
 * §3.9b), so the guard lets its page through. Only the /view routes set it, after checking the
 * caller's place; a test pins every caller of create and update.
 */
export interface PageWriteOptions { noDocumentHome?: true }

// ── Service ────────────────────────────────────────────────────────

export class PrivateViewer {
  private viewsDir: string;
  private lastTimestamp = 0;
  /** True while documents replace read-only pages (§3.9b). Read on every create, never cached. */
  private newViewsRefused: () => boolean = () => false;

  constructor(config: PrivateViewerConfig) {
    this.viewsDir = config.viewsDir;
    if (!fs.existsSync(this.viewsDir)) {
      fs.mkdirSync(this.viewsDir, { recursive: true });
    }
  }

  /**
   * The old-link guarantee's backstop (§3.9b): every caller that makes a page goes through
   * `create`, so refusing here covers callers that do not yet know about documents. A predicate
   * that throws counts as "not refused", so a fault in the documents check never stops pages.
   */
  setNewViewGuard(refused: () => boolean): void {
    this.newViewsRefused = refused;
  }

  /** Whether `create` would refuse right now (callers check first and make a document instead). */
  newViewsAreRefused(): boolean {
    try { return this.newViewsRefused() === true; } catch { return false; /* @silent-fallback-ok: a broken documents check must not stop every page; the check's own health shows in GET /docs/health */ }
  }

  /**
   * Store markdown content for private viewing.
   * If a PIN is provided, the view requires PIN entry before content is shown.
   * Throws ViewsReplacedByDocumentsError while documents replace pages (§3.9b), unless the caller
   * has no document home (`opts.noDocumentHome`).
   */
  create(title: string, markdown: string, pin?: string, metadata?: PrivateViewMetadata, opts: PageWriteOptions = {}): PrivateView {
    if (opts.noDocumentHome !== true && this.newViewsAreRefused()) throw new ViewsReplacedByDocumentsError();
    const id = crypto.randomUUID();
    // Ensure monotonically increasing timestamps even within same millisecond
    let now = Date.now();
    if (now <= this.lastTimestamp) {
      now = this.lastTimestamp + 1;
    }
    this.lastTimestamp = now;

    const view: PrivateView = {
      id,
      title,
      markdown,
      createdAt: new Date(now).toISOString(),
    };
    if (pin) {
      view.pinHash = crypto.createHash('sha256').update(pin).digest('hex');
    }
    if (metadata && Object.keys(metadata).length > 0) {
      view.metadata = metadata;
    }
    this.save(view);
    return view;
  }

  /**
   * Update an existing view.
   */
  update(id: string, title: string, markdown: string, opts: PageWriteOptions = {}): PrivateView | null {
    // Rewriting an old page is new content on an old-style link: refused the same way (§3.9b).
    if (opts.noDocumentHome !== true && this.newViewsAreRefused()) throw new ViewsReplacedByDocumentsError();
    const existing = this.get(id);
    if (!existing) return null;

    existing.title = title;
    existing.markdown = markdown;
    existing.updatedAt = new Date().toISOString();
    this.save(existing);
    return existing;
  }

  /**
   * Get a view by ID.
   */
  get(id: string): PrivateView | null {
    const filePath = path.join(this.viewsDir, `${id}.json`);
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * List all views.
   */
  list(): PrivateView[] {
    try {
      const files = fs.readdirSync(this.viewsDir).filter(f => f.endsWith('.json'));
      return files.map(f => {
        try {
          return JSON.parse(fs.readFileSync(path.join(this.viewsDir, f), 'utf-8')) as PrivateView;
        } catch {
          return null;
        }
      }).filter((v): v is PrivateView => v !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return [];
    }
  }

  /**
   * Delete a view.
   */
  delete(id: string): boolean {
    const filePath = path.join(this.viewsDir, `${id}.json`);
    try {
      if (!fs.existsSync(filePath)) return false;
      SafeFsExecutor.safeUnlinkSync(filePath, { operation: 'src/publishing/PrivateViewer.ts:139' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Verify a PIN against a view's stored hash.
   */
  verifyPin(id: string, pin: string): boolean {
    const view = this.get(id);
    if (!view || !view.pinHash) return false;
    const hash = crypto.createHash('sha256').update(pin).digest('hex');
    return crypto.timingSafeEqual(
      Buffer.from(hash, 'hex'),
      Buffer.from(view.pinHash, 'hex'),
    );
  }

  /**
   * Render the page shown for a PIN-protected view.
   *
   * Every /view response is served under `Content-Security-Policy: sandbox …` with no
   * `allow-scripts` and no `allow-forms` (dashboard-conversations-browser-device §4.12), so a PIN
   * form could never submit. The page states that plainly instead of showing a form that cannot work.
   * Repairing the unlock is a separate change (feedback fb-fa94058c-e42). `_error` is kept for
   * callers that still pass it.
   */
  renderPinPage(view: PrivateView, _error = false): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(view.title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f8f9fa;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      color: #1a1a2e;
    }
    .pin-box {
      background: #fff;
      border-radius: 12px;
      padding: 2.5rem;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
      max-width: 380px;
      width: 90%;
      text-align: center;
    }
    .pin-box h1 { font-size: 1.3rem; margin-bottom: 0.5rem; color: #16213e; }
    .pin-box p { font-size: 0.95rem; color: #555; line-height: 1.45; }
    .lock-icon { font-size: 2rem; margin-bottom: 0.75rem; }
  </style>
</head>
<body>
  <div class="pin-box">
    <div class="lock-icon">&#128274;</div>
    <h1>${escapeHtml(view.title)}</h1>
    <p>${VIEW_PIN_NOTICE}</p>
  </div>
</body>
</html>`;
  }

  /**
   * Render a view as self-contained HTML.
   */
  renderHtml(view: PrivateView): string {
    const bodyHtml = marked.parse(view.markdown, { async: false, gfm: true }) as string;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(view.title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: #1a1a2e;
      background: #f8f9fa;
      padding: 0;
    }
    .container {
      max-width: 720px;
      margin: 0 auto;
      padding: 2rem 1.5rem;
      background: #fff;
      min-height: 100vh;
    }
    h1 {
      font-size: 1.8rem;
      margin-bottom: 0.5rem;
      color: #16213e;
      border-bottom: 2px solid #e8e8e8;
      padding-bottom: 0.5rem;
    }
    .meta {
      font-size: 0.85rem;
      color: #888;
      margin-bottom: 2rem;
    }
    h3 { font-size: 1.4rem; margin: 1.5rem 0 0.75rem; color: #16213e; }
    h4 { font-size: 1.15rem; margin: 1.25rem 0 0.5rem; color: #16213e; }
    p { margin: 0.75rem 0; }
    a { color: #0f3460; text-decoration: underline; }
    a:hover { color: #533483; }
    strong { font-weight: 600; }
    em { font-style: italic; }
    s { text-decoration: line-through; color: #888; }
    code {
      font-family: 'SF Mono', 'Fira Code', monospace;
      background: #f0f0f0;
      padding: 0.15em 0.35em;
      border-radius: 3px;
      font-size: 0.9em;
    }
    pre {
      background: #1a1a2e;
      color: #e8e8e8;
      padding: 1rem;
      border-radius: 6px;
      overflow-x: auto;
      margin: 1rem 0;
    }
    pre code {
      background: none;
      padding: 0;
      color: inherit;
      font-size: 0.85rem;
    }
    blockquote {
      border-left: 3px solid #533483;
      padding: 0.5rem 1rem;
      margin: 1rem 0;
      color: #555;
      background: #faf8ff;
      border-radius: 0 4px 4px 0;
    }
    ul, ol { margin: 0.75rem 0; padding-left: 1.5rem; }
    li { margin: 0.25rem 0; }
    hr {
      border: none;
      border-top: 1px solid #e0e0e0;
      margin: 1.5rem 0;
    }
    img { max-width: 100%; border-radius: 4px; }
    figure { margin: 1rem 0; }
    figcaption { font-size: 0.85rem; color: #888; text-align: center; margin-top: 0.25rem; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { border: 1px solid #e0e0e0; padding: 0.5rem 0.75rem; text-align: left; }
    th { background: #f0f0f0; font-weight: 600; }
    tr:nth-child(even) { background: #fafafa; }
    input[type="checkbox"] { margin-right: 0.4rem; }
    .footer {
      margin-top: 3rem;
      padding-top: 1rem;
      border-top: 1px solid #e8e8e8;
      font-size: 0.8rem;
      color: #aaa;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${escapeHtml(view.title)}</h1>
    <div class="meta">${new Date(view.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${view.updatedAt ? ' (updated)' : ''}</div>
    ${bodyHtml}
    <div class="footer">Served by Instar</div>
  </div>
</body>
</html>`;
  }

  private save(view: PrivateView): void {
    const filePath = path.join(this.viewsDir, `${view.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(view, null, 2));
  }
}

// ── HTML Rendering ─────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

