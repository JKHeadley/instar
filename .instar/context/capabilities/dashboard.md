# Dashboard

Visual web interface for monitoring and managing sessions. Accessible from any device (phone, tablet, laptop) via tunnel.

## Access

- **Local**: `http://localhost:4042/dashboard`
- **Remote**: When a tunnel is running, the dashboard is accessible at `{tunnelUrl}/dashboard`

## Authentication

Uses a 6-digit PIN (auto-generated in `dashboardPin` in `.instar/config.json`). NEVER mention "bearer tokens" or "auth tokens" to users — just give them the PIN.

## Features

- Real-time terminal streaming of all running sessions
- Session management
- Model badges
- Mobile-responsive

## Sharing the Dashboard

When the user wants to check on sessions from their phone, give them the tunnel URL + PIN. Read the PIN from your config.json. Check tunnel status: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/tunnel`

## Dashboard Telegram Topic

A dedicated "Dashboard" topic is auto-created in your Telegram group on server startup. It always contains the latest dashboard URL + PIN, pinned for instant access. If your tunnel URL changes (quick tunnel restart), a new message is posted and pinned automatically. Users should check this topic for the current dashboard link. If you have a named tunnel (persistent URL), the link never changes.

# File Viewer (Dashboard Tab)

Browse and edit project files from any device via the Files tab.

## Features

- **Browse files**: Files tab in the dashboard shows configured directories with rendered markdown and syntax-highlighted code
- **Edit files**: Files in editable paths can be edited inline from your phone. Save with Cmd/Ctrl+S.
- **Link to files**: Generate deep links: `{dashboardUrl}?tab=files&path=.claude/CLAUDE.md`
- **When to link vs inline**: Prefer dashboard links for long files (>50 lines) and when editing is needed. Show short files inline AND provide a link.

## File Viewer Endpoints

- **Config API**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/api/files/config`
- **Update paths**: `curl -X PATCH -H "Authorization: Bearer $AUTH" -H "X-Instar-Request: 1" -H "Content-Type: application/json" http://localhost:4042/api/files/config -d '{"allowedPaths":[".claude/","docs/","src/"]}'`
- **Generate a file link**: `curl -H "Authorization: Bearer $AUTH" "http://localhost:4042/api/files/link?path=.claude/CLAUDE.md"`
- **Download a file**: `curl -H "Authorization: Bearer $AUTH" "http://localhost:4042/api/files/download?path=.instar/AGENT.md" -O`

## Default Config

Browsing and editing enabled for the entire project directory (`./`) by default.

## Never Editable

`.claude/hooks/`, `.claude/scripts/`, `node_modules/` are always read-only regardless of config.
