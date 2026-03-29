/**
 * SecretDrop — Secure secret submission from user to agent.
 *
 * When an agent needs a secret (API key, password, token), it creates a
 * one-time-use, time-limited URL. The user opens the link in a browser,
 * submits the secret via a clean form, and the agent receives it directly —
 * never passing through Telegram or any chat history.
 *
 * Security properties:
 * - One-time use: token destroyed after successful submission
 * - Time-limited: expires after configurable TTL (default 15 minutes)
 * - In-memory only: pending requests and secrets never touch disk
 * - CSRF protection: form includes a hidden CSRF token
 * - Rate-limited: max submissions per IP
 * - XSS-safe: all rendered content is escaped
 * - The URL token IS the auth — no login or bearer token needed
 */
import crypto from 'node:crypto';
// ── Service ────────────────────────────────────────────────────────
const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_PENDING = 20;
const TOKEN_BYTES = 32; // 256-bit
export class SecretDrop {
    pending = new Map();
    received = new Map();
    cleanupTimer;
    agentName;
    constructor(agentName) {
        this.agentName = agentName;
        // Periodic cleanup of expired requests
        this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
        this.cleanupTimer.unref();
    }
    /**
     * Create a new secret request. Returns the token for URL construction.
     */
    create(options) {
        if (this.pending.size >= MAX_PENDING) {
            // Clean up expired first
            this.cleanup();
            if (this.pending.size >= MAX_PENDING) {
                throw new Error(`Too many pending secret requests (max ${MAX_PENDING})`);
            }
        }
        const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
        const csrfToken = crypto.randomBytes(16).toString('hex');
        const now = Date.now();
        const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
        const fields = options.fields ?? [{
                name: 'secret',
                label: options.label,
                masked: true,
                placeholder: 'Paste your secret here',
            }];
        const request = {
            token,
            csrfToken,
            label: options.label,
            description: options.description,
            fields,
            topicId: options.topicId,
            createdAt: now,
            expiresAt: now + ttlMs,
            onReceive: options.onReceive,
            agentName: this.agentName,
        };
        this.pending.set(token, request);
        return { token };
    }
    /**
     * Get a pending request by token. Returns null if expired or not found.
     */
    getPending(token) {
        const request = this.pending.get(token);
        if (!request)
            return null;
        if (Date.now() > request.expiresAt) {
            this.pending.delete(token);
            return null;
        }
        return request;
    }
    /**
     * Submit a secret. Validates CSRF, consumes the request (one-time use),
     * fires the callback, and stores the submission for retrieval.
     * Returns the submission on success, null on failure.
     */
    submit(token, csrfToken, values) {
        const request = this.getPending(token);
        if (!request)
            return null;
        // Verify CSRF token (timing-safe)
        const ha = crypto.createHash('sha256').update(csrfToken).digest();
        const hb = crypto.createHash('sha256').update(request.csrfToken).digest();
        if (!crypto.timingSafeEqual(ha, hb)) {
            return null;
        }
        // Validate all required fields are present and non-empty
        for (const field of request.fields) {
            const value = values[field.name];
            if (!value || typeof value !== 'string' || value.trim().length === 0) {
                return null;
            }
        }
        // Strip any extra fields — only accept declared fields
        const cleanValues = {};
        for (const field of request.fields) {
            cleanValues[field.name] = values[field.name].trim();
        }
        // Consume the request (one-time use)
        this.pending.delete(token);
        const submission = {
            values: cleanValues,
            receivedAt: new Date().toISOString(),
            label: request.label,
            topicId: request.topicId,
        };
        // Store submission briefly for retrieval (auto-cleanup in 5 minutes)
        this.received.set(token, submission);
        setTimeout(() => this.received.delete(token), 5 * 60 * 1000).unref();
        // Fire callback if provided
        if (request.onReceive) {
            try {
                request.onReceive(cleanValues);
            }
            catch (err) {
                // @silent-fallback-ok — caller-provided callback, errors must not break submission
                console.error('[secret-drop] onReceive callback error:', err instanceof Error ? err.message : String(err));
            }
        }
        return submission;
    }
    /**
     * Retrieve a received submission (for polling-based retrieval).
     * Returns and removes the submission.
     */
    getReceived(token) {
        const submission = this.received.get(token);
        if (!submission)
            return null;
        this.received.delete(token);
        return submission;
    }
    /**
     * List all pending requests (for the agent's management API).
     */
    listPending() {
        const now = Date.now();
        const results = [];
        for (const [token, req] of this.pending) {
            results.push({
                token,
                label: req.label,
                topicId: req.topicId,
                createdAt: req.createdAt,
                expiresAt: req.expiresAt,
                expired: now > req.expiresAt,
            });
        }
        return results;
    }
    /**
     * Cancel a pending request.
     */
    cancel(token) {
        return this.pending.delete(token);
    }
    /**
     * Remove expired requests.
     */
    cleanup() {
        const now = Date.now();
        for (const [token, req] of this.pending) {
            if (now > req.expiresAt) {
                this.pending.delete(token);
            }
        }
    }
    /**
     * Render the secret submission form as self-contained HTML.
     */
    renderForm(request) {
        const fieldsHtml = request.fields.map(field => `
      <div class="field">
        <label for="field-${escapeAttr(field.name)}">${escapeHtml(field.label)}</label>
        <input
          type="${field.masked !== false ? 'password' : 'text'}"
          id="field-${escapeAttr(field.name)}"
          name="${escapeAttr(field.name)}"
          placeholder="${escapeAttr(field.placeholder || '')}"
          autocomplete="off"
          spellcheck="false"
          required
        >
      </div>
    `).join('');
        const minutesLeft = Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 60_000));
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Secret Drop — ${escapeHtml(request.label)}</title>
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
      padding: 1rem;
    }
    .drop-box {
      background: #fff;
      border-radius: 12px;
      padding: 2.5rem;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
      max-width: 460px;
      width: 100%;
    }
    .agent-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      background: #f0edf6;
      color: #533483;
      padding: 0.25rem 0.75rem;
      border-radius: 20px;
      font-size: 0.8rem;
      font-weight: 500;
      margin-bottom: 1rem;
    }
    .agent-badge .dot {
      width: 8px; height: 8px;
      background: #27ae60;
      border-radius: 50%;
    }
    h1 {
      font-size: 1.3rem;
      margin-bottom: 0.5rem;
      color: #16213e;
    }
    .description {
      font-size: 0.9rem;
      color: #666;
      margin-bottom: 1.5rem;
      line-height: 1.5;
    }
    .expiry {
      font-size: 0.8rem;
      color: #999;
      margin-bottom: 1.5rem;
    }
    .field {
      margin-bottom: 1.25rem;
    }
    .field label {
      display: block;
      font-size: 0.85rem;
      font-weight: 500;
      color: #444;
      margin-bottom: 0.35rem;
    }
    .field input {
      width: 100%;
      padding: 0.7rem 0.9rem;
      font-size: 0.95rem;
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      outline: none;
      transition: border-color 0.2s;
      background: #fafafa;
    }
    .field input:focus {
      border-color: #533483;
      background: #fff;
    }
    .submit-btn {
      width: 100%;
      padding: 0.8rem;
      margin-top: 0.5rem;
      background: #16213e;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }
    .submit-btn:hover { background: #533483; }
    .submit-btn:disabled { background: #aaa; cursor: not-allowed; }
    .security-note {
      margin-top: 1.25rem;
      padding: 0.75rem;
      background: #f8f9fa;
      border-radius: 8px;
      font-size: 0.78rem;
      color: #888;
      line-height: 1.5;
    }
    .security-note strong { color: #666; }
    .success {
      text-align: center;
      padding: 2rem 0;
    }
    .success .check {
      font-size: 3rem;
      margin-bottom: 1rem;
    }
    .success h2 {
      font-size: 1.2rem;
      color: #27ae60;
      margin-bottom: 0.5rem;
    }
    .success p {
      font-size: 0.9rem;
      color: #666;
    }
    .error-banner {
      background: #fdf0f0;
      color: #c0392b;
      padding: 0.6rem 0.9rem;
      border-radius: 6px;
      font-size: 0.85rem;
      margin-bottom: 1rem;
      display: none;
    }
  </style>
</head>
<body>
  <div class="drop-box">
    <div id="form-view">
      <div class="agent-badge"><span class="dot"></span> ${escapeHtml(request.agentName)}</div>
      <h1>${escapeHtml(request.label)}</h1>
      ${request.description ? `<p class="description">${escapeHtml(request.description)}</p>` : ''}
      <p class="expiry">This link expires in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''} and can only be used once.</p>
      <div class="error-banner" id="error-banner"></div>
      <form id="secret-form">
        <input type="hidden" name="_csrf" value="${escapeAttr(request.csrfToken)}">
        ${fieldsHtml}
        <button type="submit" class="submit-btn" id="submit-btn">Send Securely</button>
      </form>
      <div class="security-note">
        <strong>End-to-end delivery.</strong> Your secret goes directly to ${escapeHtml(request.agentName)}'s server.
        It is not stored on disk and this link will stop working after submission.
      </div>
    </div>
    <div id="success-view" style="display:none">
      <div class="success">
        <div class="check">&#10003;</div>
        <h2>Secret Received</h2>
        <p>${escapeHtml(request.agentName)} has received your secret securely.<br>You can close this page.</p>
      </div>
    </div>
  </div>
  <script>
    document.getElementById('secret-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('submit-btn');
      const errorBanner = document.getElementById('error-banner');
      btn.disabled = true;
      btn.textContent = 'Sending...';
      errorBanner.style.display = 'none';

      const formData = new FormData(e.target);
      const payload = {};
      for (const [key, value] of formData.entries()) {
        payload[key] = value;
      }

      try {
        const res = await fetch(window.location.pathname, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (res.ok) {
          document.getElementById('form-view').style.display = 'none';
          document.getElementById('success-view').style.display = 'block';
        } else {
          const data = await res.json().catch(() => ({}));
          errorBanner.textContent = data.error || 'Submission failed. The link may have expired.';
          errorBanner.style.display = 'block';
          btn.disabled = false;
          btn.textContent = 'Send Securely';
        }
      } catch {
        errorBanner.textContent = 'Network error. Please check your connection and try again.';
        errorBanner.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Send Securely';
      }
    });
  </script>
</body>
</html>`;
    }
    /**
     * Render an expired/not-found page.
     */
    renderExpiredPage() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Secret Drop — Expired</title>
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
      padding: 1rem;
    }
    .box {
      background: #fff;
      border-radius: 12px;
      padding: 2.5rem;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
      max-width: 400px;
      width: 100%;
      text-align: center;
    }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.3rem; margin-bottom: 0.75rem; color: #16213e; }
    p { font-size: 0.9rem; color: #666; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="box">
    <div class="icon">&#128683;</div>
    <h1>Link Expired or Already Used</h1>
    <p>This secret drop link is no longer valid. It may have expired or already been used. Ask the agent to generate a new one if needed.</p>
  </div>
</body>
</html>`;
    }
    /**
     * Shutdown — clean up timer.
     */
    shutdown() {
        clearInterval(this.cleanupTimer);
        this.pending.clear();
        this.received.clear();
    }
}
// ── HTML Escaping ──────────────────────────────────────────────────
function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
function escapeAttr(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
//# sourceMappingURL=SecretDrop.js.map