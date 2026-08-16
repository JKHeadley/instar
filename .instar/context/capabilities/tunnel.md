# Cloudflare Tunnel

Expose the local server to the internet via Cloudflare. Enables remote access to private views, the API, and file serving.

## Endpoints

- **Status**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/tunnel`

## Configuration

Configure in `.instar/config.json`:

```json
{"tunnel": {"enabled": true, "type": "quick"}}
```

## Tunnel Types

- **Quick tunnels** (default): Zero-config, ephemeral URL (*.trycloudflare.com), no account needed
- **Named tunnels**: Persistent custom domain, requires token from Cloudflare dashboard

## Remote Access

When a tunnel is running, private view responses include a `tunnelUrl` field for remote access.
