# Web Content Fetching

When fetching content from ANY URL, always try the most efficient method first. This is a mandatory hierarchy.

## Fetch Hierarchy

1. **`python3 .claude/scripts/smart-fetch.py URL --auto`** — Checks for llms.txt (machine-readable site map) first, then requests `Accept: text/markdown` from Cloudflare sites (~80% token savings on ~20% of the web), then falls back to HTML text extraction.
2. **WebFetch** (built-in Claude Code tool) — For URLs where smart-fetch isn't practical.
3. **WebSearch** (built-in Claude Code tool) — For discovery when you don't have a URL.
4. **Playwright MCP** — ONLY for pages requiring JavaScript rendering or interaction.

## Key Rule

Before using WebFetch on any URL, try `python3 .claude/scripts/smart-fetch.py URL --auto --raw` first. Many documentation sites now serve llms.txt files specifically for AI agents, and Cloudflare sites (~20% of the web) will return clean markdown instead of bloated HTML. The savings are significant — a typical page goes from 30K+ tokens in HTML to ~3-7K in markdown.
