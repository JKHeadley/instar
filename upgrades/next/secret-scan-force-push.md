# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Secret Scan uses the full history reachable from the new commit and checks the relevant files in its tree when a main push has an unavailable or divergent previous commit. The workflow separates scanner failures from credential findings.

## What to Tell Your User

A scan that cannot finish reports an operational error. Rotation advice appears only when the scanner reports a finding.

## Summary of New Capabilities

The workflow supports a main force-push whose previous commit is unavailable or no longer an ancestor.

## Evidence

A disposable repository tests normal, divergent and missing push bases. A stand-in scanner tests the workflow's exit-code handling without any real credentials.
