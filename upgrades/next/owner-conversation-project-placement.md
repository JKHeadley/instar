## What Changed

The owner conversation list includes verified project membership even when a
project has no saved conversation group. The dashboard can read the same
saved group tree as the Apple apps using its existing owner sign-in.

## What to Tell Your User

Your apps can keep conversations with the projects they belong to, even before
a saved group exists. The dashboard and Apple apps can use the same saved tree.

## Summary of New Capabilities

Owner conversation rows can identify their confirmed project. The dashboard
has an owner-only endpoint for the same tree the signed mobile endpoint returns.

## Evidence

Signed HTTP fixtures exercised nested project ancestry, a pinned project
descendant, incomplete ancestry, and an internal chat excluded by the server.
The server lifecycle fixture verified both the signed mobile and dashboard
owner reads. The persistent loopback launcher supports synthetic native
captures. Real owner pairing and the full tree layout remain to be verified.
