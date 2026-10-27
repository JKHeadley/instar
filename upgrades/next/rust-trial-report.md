<!-- internal-only -->
# Rust trial report

## What Changed

- New `docs/research/RUST-TRIAL-2026-10.md`: measured answer to "where would Rust speed up Instar", with the Rust probe and benchmark harnesses embedded. Documentation only.

## Evidence

Measurements in the report: Rust MCP probe 3 ms / 0.2 MB private vs Node Threadline helper 155 ms / 44.6 MB private (median of 7); hook start-up 20–70 ms CPU each vs 10 ms for bare `node`.
