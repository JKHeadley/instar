<!-- internal-only -->
<!-- bump: patch -->

## What Changed

Three internal paths now remove credential-shaped text from raw fields before JSON encoding. This covers deep judgment context, job completion assessments, and script supervisor prompt input.

## Evidence

Focused regressions exercise labelled values inside JSON snippets and multiline private key blocks using synthetic content.

Stop replay capture now masks private key blocks. Supervisor output is scrubbed before its length limit, and the existing supervisor patterns also run on raw strings.
