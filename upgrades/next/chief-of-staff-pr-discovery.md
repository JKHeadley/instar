# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The development Chief of Staff can search open Instar pull requests and recent merged work through the local server. It searches descriptions and branch names as well as titles. The lookup returns evidence links and shows which parts of GitHub it could read. Existing and new agents receive instructions to use the lookup before answering whether work exists or assigning a new design.

## What to Tell Your User

When you ask me whether something was already planned, I can look for the work where it actually lives, including an open pull request. I can point you to the original work and say if I could only check part of the record.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Prior pull request lookup in the development Chief of Staff | Ask whether an Instar change already exists or bring up a proposed new design. The Chief of Staff can look up the public repository and cite what it finds. |

## Evidence

The focused run passed 87 tests, including a production server startup test and a replay where the relevant pull request appears after the first 100 open results. An authenticated cold probe completed both the open scan and the recent merged scan, and returned the open pull request in 8.30 seconds. Owner-channel replies, assignments and deployment still need separate verification.
