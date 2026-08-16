# Publishing

Two publishing systems: Telegraph (public) and Private Viewer (auth-gated).

## Telegraph (Public Pages)

Share content as PUBLIC web pages via Telegraph. Instant, zero-config, accessible from anywhere.

### Endpoints

- **Publish**: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/publish -H 'Content-Type: application/json' -d '{"title":"Page Title","markdown":"# Content here"}'`
- **List published**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/published`
- **Edit**: `curl -X PUT -H "Authorization: Bearer $AUTH" http://localhost:4042/publish/PAGE_PATH -H 'Content-Type: application/json' -d '{"title":"Updated","markdown":"# New content"}'`

**CRITICAL: All Telegraph pages are PUBLIC.** Anyone with the URL can view the content. There is no authentication or access control. NEVER publish sensitive, private, or confidential information through Telegraph. When sharing a link, always inform the user that the page is publicly accessible.

## Private Viewing (Auth-Gated Pages)

Render markdown as auth-gated HTML pages, accessible only through the agent's server (local or via tunnel).

### Endpoints

- **Create**: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/view -H 'Content-Type: application/json' -d '{"title":"Report","markdown":"# Private content"}'`
- **View (HTML)**: Open `http://localhost:4042/view/VIEW_ID` in a browser
- **List**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/views`
- **Update**: `curl -X PUT -H "Authorization: Bearer $AUTH" http://localhost:4042/view/VIEW_ID -H 'Content-Type: application/json' -d '{"title":"Updated","markdown":"# New content"}'`
- **Delete**: `curl -X DELETE -H "Authorization: Bearer $AUTH" http://localhost:4042/view/VIEW_ID`

## When to Use Which

- **Use private views for sensitive content.**
- **Use Telegraph for public content.**
