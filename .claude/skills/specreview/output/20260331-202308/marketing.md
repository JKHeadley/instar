# Marketing Review: PR #30 iMessage Adapter

### Approval Status: CONDITIONAL

The feature is technically compelling and the implementation is solid, but it ships without any external-facing messaging -- no README update, no docs, no announcement copy. The conditional is: approve the code, require messaging artifacts before public announcement.

---

### Name Analysis

**"imessage adapter"** vs. **"Apple Messages integration"** -- use neither. Use **"iMessage support"** in marketing copy.

"iMessage adapter" is developer vocabulary. "Apple Messages integration" is corporate and cold. "iMessage support" is direct, searchable, and what every iPhone user will type. For headlines: "Text your AI agent from your iPhone" needs no explanation.

---

### Positioning

This is genuinely differentiated. iMessage bots are almost nonexistent -- the technical barriers (macOS-only, Full Disk Access, chat.db direct access) have kept the field thin. iMessage is the default app for ~55% of US smartphone users. Every AI wrapper has a Telegram bot. Almost none work from the app where users already live. This positions instar not as a power tool but as infrastructure that integrates into existing life.

---

### Platform Story

Compelling. Conversation history persists (CONTINUATION handling is solid), it works across iPhone/iPad/Watch/Mac, no app to install on the user side. The constraint -- the Mac running instar must stay on -- is not a weakness given the existing instar user who already runs a persistent agent. It is an upgrade to their setup.

---

### README Gap

No README changes in this PR. Minimum needed before announcement: a "Messaging Channels" section listing iMessage alongside Telegram/WhatsApp, a copyable config snippet, and a prerequisites callout for Full Disk Access.

---

### Competitive Framing

OpenAI and Anthropic consumer products don't have iMessage support -- this is a legitimate differentiator. Avoid comparing to Siri/Apple Intelligence. Don't poke Apple in marketing copy.

---

### Risk: Could Apple Object?

Moderate risk, manageable. Reading `chat.db` via SQLite with user-granted Full Disk Access is the established, consented method. AppleScript automation of Messages.app is documented and supported. Apple has never taken enforcement action against Homebrew tools in this space. The risk is future macOS changes. Recommend: proceed, but add a disclaimer about requiring updates after macOS upgrades. Never use language like "bypass" or "intercept."

---

### Score: 8/10

Genuine differentiation, technically solid, high emotional resonance. Held back by: no user-facing docs, dependency on a third-party Homebrew tap (`steipete/tap/imsg`) for the critical send path, macOS-only constraint, and unacknowledged platform risk.

**Net verdict:** Ship the code. Write the docs. Announce when the `imsg` dependency is confirmed stable.
