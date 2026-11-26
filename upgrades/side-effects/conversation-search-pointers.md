# Side-effects review for finding earlier conversations

**Scale and tier.** Tier 1, 18 files. The change updates lookup instructions and literal query construction using existing routes, stores, and authorization. One independent review round checked freshness and migration parity, the visibility boundary, and matching against the stores' tokenizer. It prompted the coverage guidance and a regression for contractions.

**Readers and writers.** New agents get the lookup wording through the scaffold. Existing reference-layout agents regenerate managed guidance from the scaffold. The legacy patch recognizes the shipped lines and exact shipped capability block. It preserves other text. All three existing FTS stores use the shared literal-term renderer. The existing stores own their schemas, sources, ranking, and database writes.

**Results and coverage.** Existing stopword and fallback behavior remains in SemanticMemory. The deliberate matching change is to keep punctuation inside literal phrases so the index tokenizes punctuation as it did on insertion. A token containing a dot, hyphen, or apostrophe can match adjacent indexed words. This uses FTS token boundaries. Check the original source to verify its punctuation. The guide names the search response's coverage fields and the Telegram fallback when app conversation search is unavailable.

**Authority and supervision.** These routes retain their own authorization and principal checks. The guidance only points to documented read paths. Search results and missing results are evidence for agent judgment, in keeping with Signal vs. Authority and Verify the State, Not Its Symbol. Agents read the results as evidence when deciding where to look next.

**Roll back.** Revert the text and query-renderer change. The existing indexes support either query renderer. The previously installed guidance will still point to a route that existed before this change; reference-layout agents regenerate guidance at update.

**Evidence.** Unit regressions cover actual indexed matches and misses for dotted and hyphenated names as well as apostrophes, and check fresh guidance and exact legacy replacements. HTTP integration checks the actual Telegram route. Reference-layout integration and fresh-init lifecycle check the files the agent reads.
