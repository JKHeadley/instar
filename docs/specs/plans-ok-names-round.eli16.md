# Plan approvals say what the OK is for

## What this is

A project plan runs in rounds, and before each round starts the plan waits for the owner's OK. In the dashboard's "Needs you" list, in the Plans page and in the phone app, that ask read "Waiting for your OK on round 1". The 20 November live check of the dashboard (the "finish the dashboard makeover" project) flagged this as a needs-you item that doesn't say plainly what is being asked: "round 1" means nothing without opening the plan.

## What changes

Every round already has a short name written by whoever planned it, for example "Tier 1 - stop silent loss of local fixes". The ask now carries that name: "Waiting for your OK on round 1: Tier 1 - stop silent loss of local fixes". The same words appear in all three places: the dashboard Needs-you list and Plans page (the console's needsYouWords and the plan's detail card), and the phone app's plan list (the server's needsWords). A long name is shortened at a word boundary to about 80 characters with "…". A round with no name reads exactly as before.

## What is not affected

Nothing about when an OK is needed, what the OK does, or who can give it. The button, the permission it records and the plan's behaviour are unchanged. This only changes words on screen.

## Safeguards

The name is cleaned the same way other plan text shown in the app already is (control characters removed, length capped). Undoing this commit brings back the old words exactly.

## What you need to decide

Nothing. It is a small, reversible wording change that makes an existing ask clearer.
