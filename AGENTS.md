<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## FuseHub is a sellable, generic product

This codebase is one shared multi-tenant deployment — every account (the
agency's own and every future paying customer) runs the exact same code,
distinguished only by `account_id`/RLS. Never hardcode an account id,
email, or any other agency-specific identifier into application code to
special-case behavior. If something needs to behave differently for one
account (a beta feature, a request from one customer, an internal-only
tool), it must be a **data-driven, per-account opt-in**, never a code
branch keyed on who the account belongs to.

### Per-account feature flags

`accounts.feature_flags` is a JSONB column (migration 062) for exactly
this: `{"some_feature": true}`. Convention:

- Default behavior (flag absent or `false`) must be what every new
  signup gets — the sellable product's baseline, not the agency's
  current preference.
- Gate the new behavior in code with `account.feature_flags?.key === true`.
- Turn a flag on for a specific account with a plain SQL `UPDATE`
  against that account's row — never in application code, never by
  checking `account_id` in a conditional.
- Reuse this one column for every future per-account toggle rather than
  adding a dedicated boolean column (and a new migration) per feature.

Example: `capture_manual_wa_replies` — whether messages a rep sends
manually from their own phone (not through the CRM) get recorded into
the conversation thread. See `src/app/api/uazapi/webhook/route.ts`.
