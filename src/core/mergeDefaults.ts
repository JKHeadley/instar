/**
 * mergeDefaults — lay optional config over a defaults object WITHOUT letting an
 * `undefined` value erase a default.
 *
 * Why this exists: `{ ...DEFAULTS, ...cfg }` reads like "fill in whatever the
 * caller left out", but object spread copies every OWN key — including a key
 * whose value is `undefined`. The common wiring shape
 *
 *     new Thing(deps, { tickIntervalMs: someCfg.tickIntervalMs })
 *
 * therefore hands the constructor an explicit `tickIntervalMs: undefined`
 * whenever the operator's config omits the field, and the spread REPLACES the
 * default with it. On 2026-09-21 that is exactly how ContextWedgeSentinel ended up
 * calling `setInterval(tick, undefined)` — which Node runs every ~1ms — on every
 * agent whose config left `tickIntervalMs` unset. Each tick captured every live
 * session's tmux pane synchronously, so an agent with five live conversations
 * spent ~78% of its main thread blocked, its 250ms Telegram send permits expired,
 * and replies were held for 5–25 minutes. SystemReviewer had already hit the same
 * class (a `disabledProbes: undefined` override → TypeError) and fixed it locally
 * with an inline filter; nothing stopped the next constructor repeating it.
 *
 * Semantics: identical to `{ ...defaults, ...override1, ...override2 }` EXCEPT
 * that an override key whose value is `undefined` is skipped, so the value to its
 * left survives. `null` is NOT skipped — in JSON config `null` is an explicit,
 * meaningful value (e.g. "no soak window"), whereas `undefined` can only mean
 * "not provided". A `null`/`undefined` override object is ignored entirely.
 *
 * Shallow by design, like the spread it replaces: nested objects are replaced
 * wholesale, not deep-merged. Own enumerable string keys only, exactly like
 * spread; every key (including "__proto__") lands as an own data property.
 *
 * `scripts/lint-no-undefined-erasing-default-merge.js` keeps new code on this
 * helper instead of the raw spread.
 */
export function mergeDefaults<D extends object>(
  defaults: D,
  // NoInfer: D is taken from the DEFAULTS alone. Otherwise a `Partial<Config>`
  // override would drag D down to the optional-field type and the result would
  // lose its `Required<…>` guarantee.
  ...overrides: ReadonlyArray<Partial<NoInfer<D>> | null | undefined>
): D {
  const out = { ...defaults } as Record<string, unknown>;
  for (const override of overrides) {
    if (override === null || override === undefined) continue;
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) continue;
      // defineProperty, not `out[key] = value`: spread creates an OWN data
      // property for every key, so a JSON override carrying "__proto__" stays a
      // harmless own property. Plain assignment would invoke the prototype
      // setter and re-parent the merged object — a divergence from the spread
      // this helper replaces (overrides are read from on-disk JSON in places).
      Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
    }
  }
  return out as D;
}

/**
 * Resolve a timer duration taken from config.
 *
 * - Not a finite number (undefined, NaN, Infinity, a stray string) → `fallback`.
 * - Finite but below `floorMs` → `floorMs`.
 * - Otherwise → the value unchanged.
 *
 * Use it for any REPEATING timer whose period comes from config: `setInterval`
 * with a missing or zero period does not fail, it spins (Node clamps the delay
 * to 1ms), and a spinning loop that does real work starves the event loop.
 * One-shot delays (a confirm window, a debounce) usually want `floorMs: 0`.
 */
export function resolveTimerMs(value: unknown, fallback: number, floorMs = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value < floorMs ? floorMs : value;
}
