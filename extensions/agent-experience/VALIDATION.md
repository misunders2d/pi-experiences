# Agent Experience validation

Run from package root:

```bash
npm run check
```

Phase 7b/8 validation expectations:

- selector instant mode makes zero model/network calls;
- smart mode resolves configured provider/model through registry/auth and fails closed;
- shared selector gates hold for both modes;
- no raw prompt/session/injected text is persisted;
- `prompt_hash` remains `omitted`;
- dry-run consolidation creates no durable mutation;
- range mismatch shapes shrink/expand/shift quarantine on non-dry-run and do not advance watermarks;
- single-writer lock blocks concurrent consolidation;
- systemd files are templates only and not installed by checks;
- break-in review-only path makes no commit unless accepted/threshold-enabled;
- rollback restores real artifacts with explicit overwrite and DB-closed confirmation;
- status/report/calibration surfaces expose redacted aggregates only.

Live runtime validation is separate and requires explicit user approval before install/reload/smoke.
