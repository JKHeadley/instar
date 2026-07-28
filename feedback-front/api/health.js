// src/health.ts
function handler(_req, res) {
  res.status(200).json({
    ok: true,
    service: "instar-feedback-receiver-front",
    phase: 0,
    note: "no-traffic; verify-only (no persistence until Phase 3)"
  });
}
export {
  handler as default
};
