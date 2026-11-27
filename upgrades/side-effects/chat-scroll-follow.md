# Side-Effects Review — Keep the Reader's Place in Chats

## Summary

Tier 1. Chats measures whether its scroll pane is already at the bottom before updating history. It follows new arrivals only from that position. An existing reader gets a New messages button for an appended message.

## Decision-point Inventory

A two-pixel tolerance accounts for CSS fractional scroll offsets. Initial history, loading older messages, and repeated observations of known IDs do not raise a new-message cue. Current browser send, opening a conversation and clicking the new button remain explicit jumps. The backfill anchor is measured just before applying older messages, after the request returns.

## 6b. Operator-surface Quality

The visible action says New messages. It is a native button with a 44 CSS-pixel target. Activating it clears the button and takes the reader to the end. Keyboard activation transfers focus to the scrollable message log. Existing route and message identifiers remain internal.

## Multi-machine Posture

The view computes the cue from the existing merged history and event reads. No request, polling schedule, delivery state, or authorization change. No new notice is sent outside the page.

## Rollback

Revert the view and CSS. No state or preference migration.

## Class-Closure Declaration

No agent-authored-artifact defect or new scheduled controller.
