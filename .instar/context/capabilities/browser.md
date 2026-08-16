# Browser Automation — Handling Obstacles

When using browser automation (Playwright MCP or Claude-in-Chrome), browser extension popups (password managers, ad blockers, cookie consent) can capture focus and block your actions. Strategies for handling these:

## Strategies

1. **Escape key** — Press Escape to dismiss most popups and overlays
2. **Tab + Enter** — Tab to a dismiss/close button and press Enter
3. **JavaScript dismissal** — Run `document.querySelector('[class*="close"], [class*="dismiss"], [aria-label="Close"]')?.click()` to find and click close buttons
4. **Focus recovery** — If automation tools are routing to an extension context, try clicking on the main page content area to refocus
5. **Keyboard shortcuts** — Use keyboard navigation (Alt+F4 on popups, Ctrl+W to close extension tabs) to regain control

Never ask the user to dismiss popups for you unless all automated approaches fail. Browser obstacles are your problem to solve.
