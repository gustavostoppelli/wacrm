"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import ptMessages from "../../../../messages/pt.json";

// The "f." mark + wordmark used everywhere else FuseHub shows its own
// brand (login, dashboard shell) — signup previously used a generic
// lucide icon instead, which looked inconsistent once opened from a
// wa.me link.
function FuseHubBrand() {
  return (
    <div className="mb-2 flex items-center gap-2">
      <div
        className="flex h-9 w-9 items-center justify-center rounded-lg text-lg font-bold"
        style={{ background: "#0A5E4E" }}
        aria-hidden="true"
      >
        <span style={{ color: "#F2EDE1" }}>f</span>
        <span style={{ color: "#D8C08A" }}>.</span>
      </div>
      <span className="text-base font-semibold">
        <span className="text-foreground">fuse</span>
        <span style={{ color: "#2FA184" }}>Hub</span>
        <sup style={{ color: "#2FA184", fontSize: "0.6em" }}>&reg;</sup>
      </span>
    </div>
  );
}

// `useSearchParams` opts the component out of static prerendering
// unless wrapped in Suspense — same pattern as /login.
//
// Like /login, this is the public-facing entry point to FuseHub, so it
// always renders in Portuguese regardless of NEXT_PUBLIC_APP_LOCALE or
// any personal locale cookie — nested provider overrides the root
// layout's locale just for this subtree.
export default function SignupPage() {
  return (
    <NextIntlClientProvider locale="pt" messages={{ SignupPage: ptMessages.SignupPage }}>
      <Suspense fallback={null}>
        <SignupPageInner />
      </Suspense>
    </NextIntlClientProvider>
  );
}

function SignupPageInner() {
  const searchParams = useSearchParams();
  const t = useTranslations("SignupPage");
  // When the user lands here from `/join/<token>` we carry the
  // invite token in the query so it survives the signup → email
  // verification → redirect round-trip. `emailRedirectTo` below
  // points back at /join/<token> so the user lands on the redeem
  // step after verifying instead of being dropped on /dashboard.
  const inviteToken = searchParams.get("invite");
  // Required for a brand-new account when there's no team invite —
  // see migration 068: the account-bootstrap trigger now refuses to
  // create a new tenant without a matching, unused, unexpired
  // signup_invitations row. Checking for its presence here is a UX
  // nicety (a clear message instead of a cryptic signUp() failure);
  // the trigger is what actually enforces this, so there's nothing to
  // bypass by messing with this query param.
  const signupToken = searchParams.get("signup_token");
  const hasValidEntry = !!inviteToken || !!signupToken;

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(t("passwordMismatch"));
      return;
    }

    if (password.length < 6) {
      setError(t("passwordTooShort"));
      return;
    }

    if (!acceptedTerms) {
      setError(t("mustAcceptTerms"));
      return;
    }

    setLoading(true);

    // If we have an invite token, point Supabase's verification
    // email back at the join page so the user can accept after
    // verifying. Without a token, Supabase uses its default
    // redirect (the app root).
    const emailRedirectTo = inviteToken
      ? `${window.location.origin}/join/${encodeURIComponent(inviteToken)}`
      : undefined;

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          // Read by handle_new_user (migration 068) to decide whether
          // this signup may create a brand-new tenant account. Passing
          // both is harmless — the trigger only needs one to match.
          ...(inviteToken ? { invite_token: inviteToken } : {}),
          ...(signupToken ? { signup_token: signupToken } : {}),
        },
        ...(emailRedirectTo ? { emailRedirectTo } : {}),
      },
    });

    if (error) {
      // The trigger's own error message isn't guaranteed to reach the
      // client in a friendly form (Supabase Auth generally wraps a
      // failed post-signup trigger as a generic "Database error saving
      // new user") — a signup/invite link that's expired or already
      // used is the only way this page can reach signUp() at all
      // (hasValidEntry gates the form below), so that's the safe
      // assumption for the message here.
      setError(t("invalidOrExpiredLink"));
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  // No team invite and no signup link — the trigger would refuse to
  // create an account anyway (migration 068), so don't even show the
  // form. Keeps a bare, undiscoverable `/signup` from looking like a
  // working public signup page to whoever stumbles onto it.
  if (!hasValidEntry) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md border-border bg-card">
          <CardHeader className="items-center text-center">
            <FuseHubBrand />
            <CardTitle className="text-xl text-foreground">
              {t("gateTitle")}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t("gateDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/login">
              <Button
                variant="outline"
                className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {t("backToLogin")}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md border-border bg-card">
          <CardHeader className="items-center text-center">
            <FuseHubBrand />
            <CardTitle className="text-xl text-foreground">
              {t("successTitle")}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t.rich("successDesc", {
                emailValue: email,
                emailTag: (chunks) => <span className="text-foreground">{chunks}</span>,
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href={
                inviteToken
                  ? `/login?invite=${encodeURIComponent(inviteToken)}`
                  : "/login"
              }
            >
              <Button
                variant="outline"
                className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {t("backToSignIn")}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <FuseHubBrand />
          <CardTitle className="text-xl text-foreground">
            {inviteToken ? t("titleCreateJoin") : t("titleCreate")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {inviteToken ? t("descVerifyJoin") : t("descGetStarted")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSignup} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="fullName" className="text-muted-foreground">
                {t("fullNameLabel")}
              </Label>
              <Input
                id="fullName"
                type="text"
                placeholder={t("fullNamePlaceholder")}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-muted-foreground">
                {t("emailLabel")}
              </Label>
              <Input
                id="email"
                type="email"
                placeholder={t("emailPlaceholder")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="text-muted-foreground">
                {t("passwordLabel")}
              </Label>
              <Input
                id="password"
                type="password"
                placeholder={t("passwordPlaceholder")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirmPassword" className="text-muted-foreground">
                {t("confirmPasswordLabel")}
              </Label>
              <Input
                id="confirmPassword"
                type="password"
                placeholder={t("confirmPasswordPlaceholder")}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex items-start gap-2">
              <Checkbox
                id="acceptedTerms"
                checked={acceptedTerms}
                onCheckedChange={(checked) => setAcceptedTerms(checked === true)}
                className="mt-0.5"
              />
              <Label
                htmlFor="acceptedTerms"
                className="cursor-pointer text-xs font-normal leading-snug text-muted-foreground"
              >
                {t("termsAgreePrefix")}{" "}
                <Link
                  href="/legal/termos-de-uso"
                  target="_blank"
                  className="text-primary hover:text-primary/80"
                >
                  {t("termsOfUse")}
                </Link>{" "}
                {t("and")}{" "}
                <Link
                  href="/legal/politica-de-privacidade"
                  target="_blank"
                  className="text-primary hover:text-primary/80"
                >
                  {t("privacyPolicy")}
                </Link>
                .
              </Label>
            </div>

            <Button
              type="submit"
              disabled={loading || !acceptedTerms}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? t("creatingAccount") : t("createAccountButton")}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {t("alreadyHaveAccount")}{" "}
            <Link
              href={
                inviteToken
                  ? `/login?invite=${encodeURIComponent(inviteToken)}`
                  : "/login"
              }
              className="text-primary hover:text-primary/80"
            >
              {t("signIn")}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
