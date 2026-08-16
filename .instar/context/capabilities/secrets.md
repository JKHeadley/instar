# Secret Drop — Secure Secret Submission

Agents can collect secrets (API keys, passwords, tokens) from users without exposing them in Telegram or chat history.

## The Flow

1. Agent calls `POST /secrets/request` with a label, description, and optional topicId
2. Server returns a one-time URL (local + tunnel if available)
3. Agent sends the link to the user via Telegram
4. User opens the link in a browser — sees a clean, branded form showing what's being requested and by whom
5. User submits — secret goes directly to the agent's server
6. The link immediately expires (one-time use)
7. A confirmation message is sent to the specified Telegram topic
8. Agent retrieves the secret via `POST /secrets/retrieve/:token` or callback

## Security Properties

- 256-bit random tokens (64 hex chars)
- CSRF protection with separate form token
- One-time use — destroyed after submission
- Time-limited — 15-minute default (configurable 1min-1hr)
- In-memory only — secrets never touch disk
- Max 20 concurrent pending requests
- Timing-safe CSRF comparison
- Security headers: X-Frame-Options DENY, no-cache
- Rate-limited: max submissions per IP
- XSS-safe: all rendered content is escaped
- The URL token IS the auth — no login or bearer token needed

## Multi-Field Support

Request multiple values at once by passing a `fields` array. Each field has:
- `name` — Field identifier (e.g., "api_key", "password")
- `label` — Human-readable label shown in the form
- `masked` — Whether to mask the input (default: true)
- `placeholder` — Placeholder text

Example: request username + password together in a single form.

## Tunnel-Compatible

URLs include the tunnel URL when a Cloudflare tunnel is running, so users can submit secrets from any device.

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/secrets/request` | POST | Create a secret request. Body: `{label, description?, fields?, topicId?, ttlMs?}` |
| `/secrets/drop/:token` | GET | Serve the submission form to the user (no auth needed — token IS auth) |
| `/secrets/drop/:token` | POST | Receive the user's submission (automatic, handled by form) |
| `/secrets/retrieve/:token` | POST | Retrieve received secret values (for polling-based retrieval) |
| `/secrets/pending` | GET | List all pending secret requests |
| `/secrets/pending/:token` | DELETE | Cancel a pending request |

## What to Tell the User

"When I need a secret from you — like an API key or password — I'll send you a secure link instead of asking you to paste it in chat. The link is one-time use and expires after 15 minutes. Your secret goes directly to my server and is never stored in chat history."
