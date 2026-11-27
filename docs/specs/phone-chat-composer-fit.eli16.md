# Keep The Phone Chat Controls Above The Navigation

A phone-sized dashboard can open a chat with part of its message field and Send button behind the bottom navigation. The problem appears when the Needs-you strip is visible above the chat. The chat uses a height calculated from the whole window, but that calculation does not include the strip's actual height.

The reproduced case uses the exact assets served by the running production dashboard, checked by hash, with invented conversation and request data. At390x844,375x667 and768x1024, the visible strip put the composer and Send button36pixels behind the navigation. Without the strip, and at the desktop size, those controls were clear. Ordinary page scrolling could reveal them, so this is initial obscuration, not a claim that sending was permanently impossible.

This small CSS repair makes the phone shell share its available height among the header, Needs-you strip and chat. The message area yields space before the composer does. The bottom navigation keeps its reserved space. Desktop screens and pages without an open chat retain their existing layout. Warning and preview banners keep their natural height. The page can still scroll if a person deliberately opens a large needs list or content cannot fit.

When the needs list is deliberately open, the original document-scrolling layout stays in place. With the strip compact or absent, exceptional content can scroll inside the dashboard above navigation rather than becoming inaccessible. The fit rules ignore a hidden strip even if it retains an old open-state attribute.

The repair changes no messages, approvals, browser enrollment, API or stored preferences. It can be reversed by reverting the stylesheet. Validation compares the production-asset baseline to the same assets with only the candidate CSS substituted, then checks the original sizes and additional layout states. This is production layout evidence with synthetic content, not access to Justin's conversation or a physical phone test. Justin's real-phone and keyboard confirmation remains separate after release. Complete automated verification goes through the normal queue before release; focused measurements do not claim the whole product passed a design gate.

## Repeatable Layout Check

Use hash-verified production assets with sample content, or an already authorized QA conversation. Do not create an approved device or copy a profile just for this check. At390x844,375x667 and768x1024, compare compact visible and absent Needs-you strip states. The composer and Send rectangles must end above the fixed navigation rectangle at initial scroll. Repeat1280x728 as the unchanged desktop control and one phone case in light mode.

Open and expand a long sample needs list, scroll normally to the composer, and confirm Send is fully clear of navigation. Close the list and confirm the compact state fits again. Repeat with several unsent sample attachments and a short window: if content cannot fit initially, scrolling the outer content area must reveal the complete controls. Do not press Send. Separately check the embedded-console presentation with a declared simulated safe-area inset; label that simulation and retain real-phone/keyboard confirmation as a separate release check.
