// Page lifecycle for the console router (docs/specs/dashboard-conversations-browser-device.md §4.8).
//
// route() opens one "visit" per page render. A page may register:
//   ctx.onDispose(fn)     — called before the next render (another page, or the 30 s re-run of
//                           this one). A disposer registered after its visit ended runs at once.
//   ctx.onQuery(fn)       — when only the query of the current path changes, route() calls
//                           fn(query) instead of rebuilding the shell.
//   ctx.selfRefreshing()  — the 30 s cycle does not re-run this page; it refreshes itself.
// A throwing disposer is reported and never stops navigation. Pages that register nothing behave
// exactly as before.

export function createLifecycle({ report } = {}) {
  let current = null;
  let seq = 0;
  const safe = (fn, arg) => {
    try { fn(arg); return true; } catch (e) {
      try { if (report) report(e); } catch { /* @silent-fallback-ok: a broken reporter never stops navigation */ }
      return false;
    }
  };

  function dispose() {
    const visit = current;
    current = null;
    if (!visit) return;
    visit.live = false;
    for (const fn of visit.disposers.splice(0)) safe(fn);
  }

  function begin(path, query = '') {
    dispose();
    const visit = { token: ++seq, path, query, live: true, disposers: [], onQuery: null, selfRefreshing: false };
    current = visit;
    return {
      token: visit.token,
      isCurrent: () => visit.live,
      onDispose(fn) {
        if (typeof fn !== 'function') return;
        if (visit.live) visit.disposers.push(fn); else safe(fn);
      },
      onQuery(fn) { if (visit.live && typeof fn === 'function') visit.onQuery = fn; },
      selfRefreshing() { if (visit.live) visit.selfRefreshing = true; },
    };
  }

  /**
   * True when the change was handled in place: same path, a different query, and the page
   * registered onQuery. A throwing onQuery hands the change back to a full rebuild.
   */
  function tryQuery(path, query = '') {
    const visit = current;
    if (!visit || !visit.live || visit.path !== path || !visit.onQuery) return false;
    if (visit.query === query) return true;
    const prev = visit.query;
    visit.query = query;
    if (safe(visit.onQuery, query)) return true;
    visit.query = prev;
    return false;
  }

  return {
    begin,
    dispose,
    tryQuery,
    isSelfRefreshing: () => Boolean(current && current.live && current.selfRefreshing),
    currentToken: () => (current && current.live ? current.token : null),
  };
}

/** Splits the hash into its page path and query ('' when none). */
export function splitHash(hash) {
  const h = String(hash || '').replace(/^#\/?/, '') || 'home';
  const q = h.indexOf('?');
  return q < 0 ? { path: h, query: '' } : { path: h.slice(0, q) || 'home', query: h.slice(q + 1) };
}
