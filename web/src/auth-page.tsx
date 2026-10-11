import type { AuthSessionUser, OtpStepState, SignInChannel } from "./auth";
import type { ThemeMode } from "./theme";
import type { ReactNode, SubmitEvent } from "react";

import { useTranslate } from "@embra/i18n/react";
import { ChevronDown, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { apiPost } from "./api";
import oomolConnectLogoUrl from "./assets/oomol-connect-logo.png";
import {
  editOtpCode,
  isOtpComplete,
  otpResendRemainingSeconds,
  sanitizeNextPath,
  sendSignInCode,
  startOtpStep,
  validSignInIdentity,
  verifySignInCode,
} from "./auth";
import { InlineError, LanguageSelect, ThemeControl } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface AuthPageProps {
  /** Runtime data reload in flight (drives the operator unlock spinner). */
  loading: boolean;
  /** A signed-in session never stays on /auth — it redirects to `?next`. */
  authenticated: boolean;
  /** Operator-unlock error from the last session probe (invalid admin token). */
  operatorMessage: string | null;
  theme: ThemeMode;
  onThemeChange(theme: ThemeMode): void;
  onUnlock(token: string): void;
  onSignedIn(user: AuthSessionUser): void;
}

/**
 * `/auth` — thirdweb OTP sign-in (spec §3.5): phone or email identify step,
 * a 6-digit verify step with resend cooldown, and a collapsed operator
 * section holding the classic admin-token unlock.
 */
export function AuthPage(props: AuthPageProps): ReactNode {
  const t = useTranslate();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const next = sanitizeNextPath(searchParams.get("next"));

  const [channel, setChannel] = useState<SignInChannel>("sms");
  const [identity, setIdentity] = useState("");
  const [sentIdentity, setSentIdentity] = useState("");
  const [step, setStep] = useState<"identify" | "verify">("identify");
  const [otp, setOtp] = useState<OtpStepState>({ code: "", resendAvailableAt: 0 });
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const resendRemaining = otpResendRemainingSeconds(otp, now);

  useEffect(() => {
    if (props.authenticated) {
      navigate(next, { replace: true });
    }
  }, [props.authenticated, navigate, next]);

  useEffect(() => {
    if (step !== "verify" || resendRemaining <= 0) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [step, resendRemaining > 0]);

  function submitIdentify(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = validSignInIdentity(channel, identity);
    if (!normalized) {
      setErrorKey("invalidIdentity");
      return;
    }
    setErrorKey(null);
    setSending(true);
    void sendSignInCode(channel, normalized)
      .then((result) => {
        if (result.outcome === "sent") {
          setSentIdentity(normalized);
          setOtp(startOtpStep(Date.now()));
          setStep("verify");
        } else {
          setErrorKey(result.error);
        }
      })
      .finally(() => setSending(false));
  }

  function submitCode(code: string): void {
    if (verifying || !isOtpComplete(code)) {
      return;
    }
    setErrorKey(null);
    setVerifying(true);
    void verifySignInCode(channel, sentIdentity, code)
      .then((result) => {
        if (result.outcome === "signedIn") {
          props.onSignedIn(result.user);
          navigate(result.isNewUser ? "/welcome" : next);
          return;
        }
        if (result.outcome === "pending") {
          navigate("/auth/pending", { state: { identity: sentIdentity } });
          return;
        }
        setErrorKey(result.error);
        setOtp((state) => ({ ...state, code: "" }));
      })
      .finally(() => setVerifying(false));
  }

  function resend(): void {
    if (resendRemaining > 0 || sending) {
      return;
    }
    setErrorKey(null);
    setSending(true);
    void sendSignInCode(channel, sentIdentity)
      .then((result) => {
        if (result.outcome === "sent") {
          setOtp(startOtpStep(Date.now()));
        } else {
          setErrorKey(result.error);
        }
      })
      .finally(() => setSending(false));
  }

  function backToIdentify(): void {
    setStep("identify");
    setErrorKey(null);
    setOtp((state) => ({ ...state, code: "" }));
  }

  function onCodeChange(raw: string): void {
    const nextOtp = editOtpCode(otp, raw);
    setOtp(nextOtp);
    if (isOtpComplete(nextOtp.code)) {
      submitCode(nextOtp.code);
    }
  }

  return (
    <main className="unlock-screen">
      <section className="unlock-panel auth-panel">
        <div className="brand">
          <img className="brand-mark" src={oomolConnectLogoUrl} alt="" />
          <div>
            <div className="brand-name">WZRD Connect</div>
            <div className="brand-subtitle">{t("auth.subtitle")}</div>
          </div>
        </div>
        <LanguageSelect />
        <ThemeControl theme={props.theme} onThemeChange={props.onThemeChange} />

        <h1 className="auth-title">{t("auth.title")}</h1>

        <Tabs
          value={channel}
          onValueChange={(value) => {
            setChannel(value as SignInChannel);
            setErrorKey(null);
          }}
        >
          <TabsList className="auth-channel-tabs">
            <TabsTrigger value="sms">{t("auth.tabs.phone")}</TabsTrigger>
            <TabsTrigger value="email">{t("auth.tabs.email")}</TabsTrigger>
          </TabsList>
        </Tabs>

        {step === "identify" ? (
          <form className="form-grid" onSubmit={submitIdentify}>
            <Label className="field">
              <span>{channel === "sms" ? t("auth.phone.label") : t("auth.email.label")}</span>
              <Input
                type={channel === "sms" ? "tel" : "email"}
                inputMode={channel === "sms" ? "tel" : "email"}
                autoComplete={channel === "sms" ? "tel" : "email"}
                placeholder={channel === "sms" ? "+14155552671" : "you@example.com"}
                value={identity}
                autoFocus
                onChange={(event) => setIdentity(event.target.value)}
              />
              {channel === "sms" ? <small>{t("auth.phone.hint")}</small> : null}
            </Label>
            <Button
              className="unlock-submit"
              type="submit"
              data-loading={sending}
              aria-busy={sending}
              disabled={!identity.trim() || sending}
            >
              <span className="unlock-button-slot">
                <Loader2
                  className={sending ? "unlock-button-spinner spin" : "unlock-button-spinner idle"}
                  size={16}
                  aria-hidden="true"
                />
              </span>
              <span>{t("auth.sendCode")}</span>
              <span className="unlock-button-slot" aria-hidden="true" />
            </Button>
          </form>
        ) : (
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              submitCode(otp.code);
            }}
          >
            <Label className="field">
              <span>{t("auth.code.label")}</span>
              <Input
                className="auth-otp-input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="••••••"
                value={otp.code}
                autoFocus
                onChange={(event) => onCodeChange(event.target.value)}
              />
              <small>{t("auth.code.hint", { identity: sentIdentity })}</small>
            </Label>
            <Button
              className="unlock-submit"
              type="submit"
              data-loading={verifying}
              aria-busy={verifying}
              disabled={!isOtpComplete(otp.code) || verifying}
            >
              <span className="unlock-button-slot">
                <Loader2
                  className={verifying ? "unlock-button-spinner spin" : "unlock-button-spinner idle"}
                  size={16}
                  aria-hidden="true"
                />
              </span>
              <span>{t("auth.verify")}</span>
              <span className="unlock-button-slot" aria-hidden="true" />
            </Button>
            <div className="auth-verify-links">
              <button type="button" className="auth-link" disabled={resendRemaining > 0 || sending} onClick={resend}>
                {resendRemaining > 0 ? t("auth.resendWait", { seconds: resendRemaining }) : t("auth.resend")}
              </button>
              <button type="button" className="auth-link" onClick={backToIdentify}>
                {t("auth.changeIdentity")}
              </button>
            </div>
          </form>
        )}

        {errorKey ? (
          <div className="unlock-status" aria-live="polite">
            <InlineError message={t(`auth.errors.${errorKey}`)} />
          </div>
        ) : null}

        <details className="auth-operator">
          <summary>
            <span>{t("auth.operator.title")}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </summary>
          <div className="auth-operator-body">
            <p className="muted-copy">{t("auth.operator.description")}</p>
            <OperatorUnlockForm loading={props.loading} message={props.operatorMessage} onUnlock={props.onUnlock} />
          </div>
        </details>
      </section>
    </main>
  );
}

export interface OperatorUnlockFormProps {
  loading: boolean;
  message: string | null;
  onUnlock(token: string): void;
}

/** The admin-token paste flow that used to be the full-screen `UnlockView`. */
export function OperatorUnlockForm(props: OperatorUnlockFormProps): ReactNode {
  const t = useTranslate();
  const [token, setToken] = useState("");

  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    props.onUnlock(token.trim());
  }

  return (
    <form className="form-grid" onSubmit={submit}>
      <Label className="field">
        <span>{t("unlock.token")}</span>
        <Input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="current-password"
        />
      </Label>
      <Button
        className="unlock-submit"
        type="submit"
        data-loading={props.loading}
        aria-busy={props.loading}
        disabled={!token.trim() || props.loading}
      >
        <span className="unlock-button-slot">
          <Loader2
            className={props.loading ? "unlock-button-spinner spin" : "unlock-button-spinner idle"}
            size={16}
            aria-hidden="true"
          />
        </span>
        <span>{t("unlock.unlockConsole")}</span>
        <span className="unlock-button-slot" aria-hidden="true" />
      </Button>
      {props.message ? (
        <div className="unlock-status" aria-live="polite">
          <InlineError message={props.message} />
        </div>
      ) : null}
    </form>
  );
}

/**
 * `/auth/pending` — the allowlist gate (spec §3.4-B): the sign-in verified but
 * the deployment requires operator approval. The identity arrives via router
 * state from the just-completed OTP step.
 */
export function AuthPendingPage(props: { theme: ThemeMode; onThemeChange(theme: ThemeMode): void }): ReactNode {
  const t = useTranslate();
  const navigate = useNavigate();
  const location = useLocation();
  const identity = (location.state as { identity?: string } | null)?.identity;
  const [signingOut, setSigningOut] = useState(false);

  function signOut(): void {
    setSigningOut(true);
    void apiPost("/api/auth/logout", {})
      .catch(() => {})
      .finally(() => navigate("/auth"));
  }

  return (
    <main className="unlock-screen">
      <section className="unlock-panel auth-panel">
        <div className="brand">
          <img className="brand-mark" src={oomolConnectLogoUrl} alt="" />
          <div>
            <div className="brand-name">WZRD Connect</div>
            <div className="brand-subtitle">{t("auth.subtitle")}</div>
          </div>
        </div>
        <LanguageSelect />
        <ThemeControl theme={props.theme} onThemeChange={props.onThemeChange} />

        <h1 className="auth-title">{t("auth.pending.title")}</h1>
        {identity ? <p className="auth-pending-identity">{t("auth.pending.signedInAs", { identity })}</p> : null}
        <p className="muted-copy">{t("auth.pending.description")}</p>
        <p className="muted-copy">{t("auth.pending.note")}</p>
        <Button variant="outline" onClick={signOut} disabled={signingOut}>
          {signingOut ? <Loader2 className="spin" size={15} aria-hidden="true" /> : null}
          {t("auth.pending.signOut")}
        </Button>
      </section>
    </main>
  );
}
