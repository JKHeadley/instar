# Side-effects review

- Gross token totals remain unchanged for dashboards and general observability.
- The attribution query adds a separate fresh-cost total equal to gross usage minus cache reads.
- Existing test doubles remain compatible by falling back to gross totals when the new field is absent.
- Cache creation and output tokens still count toward burn because they carry fresh cost.
- Burn alert payload field names remain stable, but their values now represent fresh-cost tokens.
- BurnVerifier consumes the same attribution rows; its post-throttle comparison therefore measures fresh cost too.
- Second pass: the invariant is pinned at both the real ledger query and detector decision boundary.
