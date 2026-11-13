# Tunnel key no longer visible to other programs

## What Changed
A permanent (named) Cloudflare tunnel now gets its key from a private file (`--token-file`, mode 0600, in the agent's secrets folder) instead of the command line, where any program on the machine could read it. Older cloudflared binaries without `--token-file` keep the previous behavior.

## What to Tell Your User
Your agent's web tunnel used to start with its secret key visible to other programs on the computer. It now reads the key from a private file instead. Nothing else changes, and you don't need to do anything.

## Summary of New Capabilities
- Named tunnel token handed to cloudflared through a 0600 file.

## Evidence
Tests: tests/unit/cloudflare-named-token-file.test.ts. Live: on the Studio, cloudflared 2026.10.7 `tunnel run --token-file` with Echo's token registered 4 connections; its process arguments carried no token. Found by Sage Mind's device-posture check (process-arguments control failing daily on DaBombs-Mac-Studio).
