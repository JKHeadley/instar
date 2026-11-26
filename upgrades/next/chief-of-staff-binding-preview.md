# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The Chief of Staff can preview a supplied project binding batch against its current project list. The preview identifies already tracked projects and flags placements that still need source review. It requires a verified dashboard operator session and is off until `chiefOfStaff.bindingBatchPreview` is enabled.

## What to Tell Your User

You can review the batch before asking for any project or conversation changes. The preview shows what is already tracked and what still needs checking.

## Summary of New Capabilities

An enabled Chief of Staff accepts `POST /chief-of-staff/project-binding-preview` with a draft and returns its exact hash and per-item dispositions.
