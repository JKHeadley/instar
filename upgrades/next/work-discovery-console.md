# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The private Work page has a Find earlier work form for development agents with scoped dashboard sessions. It links to matching native app conversations and public Instar pull requests and shows source coverage.

## What to Tell Your User

Open Work in your private console and search for a subject or identifier. Each match links to the evidence it came from. Search coverage shows which sources were checked and where evidence is missing.

## Summary of New Capabilities

Find earlier work is available in the private browser console when its existing Work discovery endpoint is enabled.

## Evidence

DOM tests cover pending and failed searches, controlled coverage labels, text-only snippets, canonical links, and late replies after navigation. The production path test submits the shipped Work form using a session obtained from the actual owner console unlock route and verifies the returned source references on the page.

Work can also find matching pull requests when their wording differs from the search phrase. A result found this way says that all search terms matched.
