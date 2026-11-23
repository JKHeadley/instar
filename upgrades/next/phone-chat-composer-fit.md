# Phone Chat Composer Fit

<!-- bump: patch -->

## What Changed

An open phone-sized dashboard chat now sizes itself from the space remaining after the header and compact Needs-you strip, keeping the composer above bottom navigation. The message area yields height; desktop layout is unchanged.

## What to Tell Your User

The message field and Send button stay above the bottom navigation when the compact Needs-you strip appears. Opening the full needs list keeps normal scrolling.

## Summary of New Capabilities

No new capability or setting. This repairs existing phone chat layout.

## Evidence

Hash-bound production assets with sample data reproduced36px overlap at three phone/tablet sizes when the strip was visible, with absent-strip and desktop controls. The corrected candidate passes15browser geometry cases, including long expanded lists, attachments, light mode and a simulated embedded safe area. The first expanded-state regression is retained and corrected. The113existing chat/front-door tests pass and independent source review concurs; normal complete verification remains separate; no physical-phone or keyboard proof is claimed by these measurements.
