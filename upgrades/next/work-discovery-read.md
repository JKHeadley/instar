# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Development agents now have a private read-only endpoint that searches captured local native-app user-side conversation messages and public Instar pull requests. The response labels searched and unsearched sources. Both this endpoint and the Chief of Staff pull request lookup use the same cache. Private lookup words stay on the agent.

## What to Tell Your User

The first part of the work search can find an earlier local discussion and its public pull request from the same lookup. It reports what it searched and where it lacks coverage. This release prepares the private dashboard endpoint. The search field in Work and wider source coverage are separate steps.

## Summary of New Capabilities

A signed-in private dashboard session on a development agent can call `POST /work/discover` with a JSON query. The result offers original message references, public pull request links, and a coverage report.

## Evidence

Focused unit, HTTP integration, and development-agent boot tests. The boot test retrieves a real stored conversation event and an incident pull request from a fixture past the first hundred rows. Authorized coverage, revoked sessions, untrusted claims of destination, deadlines, and upstream request content are checked separately.
