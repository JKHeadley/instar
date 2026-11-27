<!-- bump: patch -->

## What Changed

Instar masks credentials in saved judgment and job diagnostics before converting the records to JSON. That preserves detection when a credential appears in a JSON snippet or a multiline private key. The stop replay copy also masks private-key blocks, and script supervision cleans output before shortening it.

## What to Tell Your User

If you review a saved diagnostic record, credential-shaped values are more reliably replaced with redaction markers. This includes keys in pasted configuration snippets and private-key blocks.

## Summary of New Capabilities

Saved diagnostic copies mask more credential formats, including multiline private keys in stop replay captures.

## Evidence

Focused regressions exercise labelled values in JSON snippets, multiline private-key blocks, labelled numbers, and the script supervisor’s output limit using synthetic content.
