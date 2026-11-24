# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The Chief of Staff pull request lookup now requires GitHub to confirm the repository is public. When GitHub reports private or unverified visibility, the service clears both cached views before serving another result.

## What to Tell Your User

The public work lookup now checks that its source is still public. It reports missing coverage when it cannot verify that.

## Summary of New Capabilities

Public source coverage uses verified GitHub repository visibility.

## Evidence

HTTPS fixtures cover a previously public snapshot followed by private and missing visibility responses. An earlier captured byte fixture remains intact and is exercised without its new proof, then with a separate unchanged live public GitHub response that explicitly includes visibility.
