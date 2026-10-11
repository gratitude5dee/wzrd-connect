import type { ThemeMode } from "./theme";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useTranslate } from "@embra/i18n/react";
import { Activity, ArrowRight, Plug, ShieldCheck } from "lucide-react";
import { Link } from "react-router";
import oomolConnectLogoUrl from "./assets/oomol-connect-logo.png";
import { LanguageSelect, ThemeControl } from "./shared-ui";
import { Button } from "@/components/ui/button";

export interface LandingPageProps {
  /** A confirmed session sends "Connect now" straight to the console (spec §7.3). */
  signedIn: boolean;
  theme: ThemeMode;
  onThemeChange(theme: ThemeMode): void;
}

// The PAP value frame: the console's own Connect / Scope / Audit story.
const landingValues = [
  { key: "connect", icon: Plug },
  { key: "scope", icon: ShieldCheck },
  { key: "audit", icon: Activity },
] satisfies readonly { key: string; icon: LucideIcon }[];

/**
 * `/` — the public landing page (spec §3.5). It renders without a session and
 * before the auth probe resolves; no console data is ever fetched for it.
 *
 * `/docs` sits behind the console session (it is served by the API and is not
 * in `isPublicPath`), so "View docs" sends signed-out visitors to `/auth` —
 * the sign-in that unlocks docs. A signed-in visitor gets a real link instead.
 */
export function LandingPage(props: LandingPageProps): ReactNode {
  const t = useTranslate();
  const consolePath = props.signedIn ? "/overview" : "/auth";

  return (
    <main className="landing-page">
      <div className="landing-column">
        <header className="landing-topbar">
          <div className="brand">
            <img className="brand-mark" src={oomolConnectLogoUrl} alt="" />
            <div className="brand-name">WZRD Connect</div>
          </div>
          <Button asChild>
            <Link to={consolePath}>
              {t("landing.connectNow")}
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </header>

        <section className="landing-hero">
          <h1 className="landing-title">{t("landing.title")}</h1>
          <p className="landing-subtitle">{t("landing.subtitle")}</p>
          <div className="landing-cta">
            <Button asChild size="lg">
              <Link to={consolePath}>
                {t("landing.connectNow")}
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
            {props.signedIn ? (
              <Button asChild variant="outline" size="lg">
                <a href="/docs">{t("landing.viewDocs")}</a>
              </Button>
            ) : (
              <Button asChild variant="outline" size="lg">
                <Link to="/auth">{t("landing.viewDocs")}</Link>
              </Button>
            )}
          </div>
        </section>

        <section className="landing-values">
          {landingValues.map((value) => {
            const Icon = value.icon;
            return (
              <div className="landing-value" key={value.key}>
                <Icon className="landing-value-icon" size={18} aria-hidden="true" />
                <h2 className="landing-value-title">{t(`landing.values.${value.key}.title`)}</h2>
                <p className="landing-value-description">{t(`landing.values.${value.key}.description`)}</p>
              </div>
            );
          })}
        </section>

        <footer className="landing-footer">
          <span className="landing-footer-brand">
            <img className="landing-footer-mark" src={oomolConnectLogoUrl} alt="" />
            WZRD Connect
          </span>
          <span className="landing-footer-tagline">{t("landing.footer")}</span>
          <div className="landing-footer-controls">
            <LanguageSelect />
            <ThemeControl theme={props.theme} onThemeChange={props.onThemeChange} />
          </div>
        </footer>
      </div>
    </main>
  );
}
