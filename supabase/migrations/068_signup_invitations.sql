-- ============================================================
-- 068_signup_invitations.sql — Close public self-signup
--
-- Until now, `/signup` created a brand-new tenant account for ANYONE
-- who reached it — the account-bootstrap trigger (`handle_new_user`,
-- migration 017) fires unconditionally on every new `auth.users` row,
-- with no gate. That's fine for a free product, but wrong for a paid
-- one: a leaked signup link would let unlimited people create free
-- accounts. Gating only the Next.js /signup PAGE would not be
-- sufficient — `auth.signUp()` is a public Supabase Auth endpoint
-- reachable directly (the anon key is meant to be public), bypassing
-- any page-level check entirely. The real gate has to live in the
-- trigger itself.
--
-- New account creation now requires a `signup_token` (this table) —
-- a single-use, expiring, hashed-at-rest credential the account owner
-- (Fuse) generates per paying customer and sends them. Joining an
-- EXISTING account via a teammate invite (`account_invitations`,
-- migration 017) is a separate, already-secure flow and is exempted
-- here (via `invite_token`) rather than also requiring a signup_token
-- — a new teammate isn't creating a new tenant.
--
-- token_hash follows the exact convention already used for api_keys
-- and inbound_webhooks: only the SHA-256 hash is stored, the
-- plaintext is generated and handed out once, out of band (a Node
-- script for now — see AGENTS.md-style "no UI yet, low volume"
-- reasoning; a real admin screen can replace that later without
-- touching this table's shape).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS signup_invitations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash     text NOT NULL UNIQUE,
  label          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  used_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS signup_invitations_token_hash_idx
  ON signup_invitations (token_hash);

ALTER TABLE signup_invitations ENABLE ROW LEVEL SECURITY;
-- No policies: this table is only ever touched by the SECURITY
-- DEFINER trigger below (runs as `postgres`, bypasses RLS) and by a
-- service-role script when generating a link. Never queried from an
-- authenticated browser session — an empty policy set correctly
-- denies both anon and authenticated roles entirely.

-- ============================================================
-- handle_new_user — now gates brand-new-tenant creation.
--
-- Reads two optional fields off `raw_user_meta_data` (passed via
-- `supabase.auth.signUp({ options: { data: { ... } } })` from the
-- client — see src/app/(auth)/signup/page.tsx):
--   - invite_token:  the plaintext token of a pending teammate
--     invite (account_invitations). Presence of a MATCHING, still-
--     valid one exempts this signup from needing a signup_token —
--     the redeem_invitation RPC (migration 019) does the real,
--     authenticated move into that account as a separate step after
--     email verification; this only decides whether to skip the
--     signup-token gate below.
--   - signup_token:  the plaintext token of a pending signup
--     invitation (this migration). Required whenever invite_token is
--     absent or doesn't match a real pending invite. Claimed
--     atomically (UPDATE ... WHERE used_at IS NULL) so two concurrent
--     signups can never both succeed off the same link.
--
-- Neither present/valid → RAISE EXCEPTION aborts the whole trigger,
-- which aborts the `auth.users` INSERT in the same transaction, which
-- surfaces as a signUp() error to the caller. SQLSTATE 22023 mirrors
-- the convention `redeem_invitation` (migration 019) already uses for
-- "invitation not found/used/expired" so error handling on the
-- client can eventually share a code path if useful.
--
-- The account/profile bootstrap itself keeps the original
-- WARN-and-continue resilience (migration 017) for unexpected
-- failures — only the two new RAISE EXCEPTION calls are meant to
-- actually block signup.
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
-- pgcrypto's digest() lives in the `extensions` schema on Supabase (not
-- `public`), so it must be on the search_path for the digest() calls
-- below to resolve — this is the first function in the repo to use it.
SET search_path = public, extensions
AS $$
DECLARE
  v_full_name TEXT;
  v_account_id UUID;
  v_invite_token TEXT;
  v_signup_token TEXT;
  v_invite_hash TEXT;
  v_signup_hash TEXT;
  v_invite_valid BOOLEAN := false;
  v_signup_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');
  v_invite_token := NEW.raw_user_meta_data->>'invite_token';
  v_signup_token := NEW.raw_user_meta_data->>'signup_token';

  IF v_invite_token IS NOT NULL AND v_invite_token <> '' THEN
    v_invite_hash := encode(digest(v_invite_token, 'sha256'), 'hex');
    SELECT true INTO v_invite_valid
    FROM public.account_invitations
    WHERE token_hash = v_invite_hash
      AND accepted_at IS NULL
      AND expires_at > now()
    LIMIT 1;
  END IF;

  IF NOT COALESCE(v_invite_valid, false) THEN
    IF v_signup_token IS NULL OR v_signup_token = '' THEN
      RAISE EXCEPTION 'signup_invitation_required' USING ERRCODE = '22023';
    END IF;

    v_signup_hash := encode(digest(v_signup_token, 'sha256'), 'hex');

    UPDATE public.signup_invitations
    SET used_at = now(), used_by_user_id = NEW.id
    WHERE token_hash = v_signup_hash
      AND used_at IS NULL
      AND expires_at > now()
    RETURNING id INTO v_signup_id;

    IF v_signup_id IS NULL THEN
      RAISE EXCEPTION 'signup_invitation_invalid' USING ERRCODE = '22023';
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.accounts (name, owner_user_id)
    VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
    RETURNING id INTO v_account_id;

    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;
