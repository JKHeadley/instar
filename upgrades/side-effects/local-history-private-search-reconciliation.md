# Local History and Private Search Reconciliation

Tier 2 source composition under docs/specs/local-history-native-contract.md, using existing private search PR3388 head43f3fd6c6 and the reconciled native stack fd662e698. Four conflict resolutions, one independent review and one concrete cross-source defect correction. No local-history native action is enabled.

## Problem and resolution

Keep current main's quoted agent views and immutable writer/private storage protections while bringing in the existing native-owner keyword search. ImportedHistoryStore imports retain both the registered SQLite writer and the streamed search reader. Server mounting retains project actions and privateImportedHistoryOwner. Awareness retains fallback, quoted titles/projects/facts and the native-owner search instructions. The location branch runs under private owner admission; the ordinary list keeps quoted agent output. Typechecking caught a renamed REF_RE call, corrected to IMPORTED_REF_RE.

An independent reader also identified that the old search assumes every source other than Claude is ChatGPT. The new local formats make that assumption unsafe. A retained red test produced a Claude Code result labeled ChatGPT. Under the approved contract, legacy APIs must omit local sources entirely: isExportSource enumerates the two implemented archive formats; source filtering precedes sorting, scan limits, message-file opening, presence disclosure and result construction. Legacy lists, project lists and keyword searches omit local records. Archive-only detail validation stays unchanged. The later sealed library is responsible for owner-scoped local access; no legacy opt-in is added.

## Side-effects review

Over-block: intended local-source exclusion from legacy APIs; supported archive behavior remains covered. Under-block: this is not a complete local-history flow; the dedicated sealed library and durable owner claims remain tracked in the approved topic143810 plan. Layer fit: format enumeration belongs in source types, store scans and actual legacy route boundaries. Signal versus authority: reference docs/signal-vs-authority.md; an explicit implemented-source domain is an invariant, not a heuristic. No new owner, browser, member or bearer privilege is created. Interactions: source exclusion happens before pagination and scan limits, preserving archive positions. Existing signature and unique-owner revalidation stay in place. External surfaces: the existing native archive search joins the composition; no local action is advertised. Multi-machine posture: archive search retains its selected-machine and no-import-fanout behavior; no raw local data is replicated. Team posture: private native search remains unique-owner-only; excluded local rows do not contribute to counts or existence. Rollback is source-only, retaining all copied data.

## Evidence and review

The local exclusion test failed before repair with a Claude Code row and incorrect ChatGPT label. After repair,106 unit,22 HTTP integration and7 production lifecycle cases passed. The lifecycle uses actual server construction and real signed owner requests, retaining normal archive search and omitting both local formats. The independent reader verified conflict resolutions and source filtering; no new concrete finding remained after REF_RE correction. Ordinary full-suite verification remains required. No installed-client, published or complete local journey claim is made.

## Class-Closure Declaration

- defectClass: unbounded-self-action
- closure: n/a
- reason: Read-only source composition and owner-requested bounded search add no autonomous controller, retry, schedule or new mutation authority.
