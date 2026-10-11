import type { AppLang } from "./i18n";
import type { ProviderDefinition } from "./model";
import type { ThemeMode } from "./theme";
import type { ReactNode } from "react";

import { useI18n, useLang, useTranslate } from "@embra/i18n/react";
import { CircleAlert, Inbox, Monitor, Moon, Sun } from "lucide-react";
import { useState } from "react";
import providerIconUrls from "virtual:oomol-provider-icons";
import { persistLang, supportedLangs } from "./i18n";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge as UiBadge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function Badge(props: { children: ReactNode; tone?: "success" | "warning" | "error" }): ReactNode {
  return (
    <UiBadge
      variant={props.tone === "error" ? "destructive" : "outline"}
      className={props.tone ? `badge ${props.tone}` : "badge"}
    >
      {props.children}
    </UiBadge>
  );
}

export function TagList(props: { values: string[]; empty: string }): ReactNode {
  const values = props.values.filter(Boolean);
  if (values.length === 0) return <p className="muted-copy">{props.empty}</p>;
  return (
    <div className="tag-list">
      {values.map((value) => (
        <span key={value} className="tag">
          {value}
        </span>
      ))}
    </div>
  );
}

export function ProviderIcon(props: { provider: ProviderDefinition; large?: boolean }): ReactNode {
  const letters = providerInitials(props.provider.displayName);
  const iconSource = providerIconSource(props.provider);
  const [failedIconSource, setFailedIconSource] = useState<string | null>(null);
  const className = props.large ? "provider-icon large" : "provider-icon";

  if (!iconSource || failedIconSource === iconSource.value) {
    return <span className={className}>{letters}</span>;
  }

  return (
    <span className={className}>
      <img
        alt=""
        className="provider-icon-image"
        loading="lazy"
        referrerPolicy="no-referrer"
        src={iconSource.value}
        onError={() => setFailedIconSource(iconSource.value)}
      />
    </span>
  );
}

export function providerInitials(displayName: string): string {
  return (
    displayName
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

interface ProviderIconSource {
  kind: "url";
  value: string;
}

export function providerIconSource(
  provider: ProviderDefinition,
  catalogIconUrls: Readonly<Record<string, string>> = providerIconUrls,
): ProviderIconSource | undefined {
  const iconUrl = provider.iconUrl?.trim();
  if (iconUrl) {
    return { kind: "url", value: iconUrl };
  }

  const catalogIconUrl = catalogIconUrls[provider.service]?.trim();
  if (catalogIconUrl) {
    return { kind: "url", value: catalogIconUrl };
  }

  const hostname = providerHomepageHostname(provider.homepageUrl);
  if (!hostname) {
    return undefined;
  }

  const searchParams = new URLSearchParams({
    larger: "true",
    "throw-error-on-404": "true",
  });
  return { kind: "url", value: `https://a.favicon.im/${hostname}?${searchParams.toString()}` };
}

function providerHomepageHostname(homepageUrl: string | undefined): string | undefined {
  if (!homepageUrl) {
    return undefined;
  }

  try {
    return new URL(homepageUrl).hostname;
  } catch {
    return undefined;
  }
}

interface EmptyStateProps {
  title: string;
  description: string;
  icon?: ReactNode | null;
  density?: "regular" | "compact";
  tone?: "neutral" | "success";
}

export function EmptyState(props: EmptyStateProps): ReactNode {
  const icon = props.icon === undefined ? <Inbox size={20} /> : props.icon;
  const className = [
    "empty-state",
    props.density === "compact" ? "compact" : undefined,
    props.tone === "success" ? "success" : undefined,
    icon == null ? "no-icon" : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className}>
      {icon}
      <strong>{props.title}</strong>
      <p>{props.description}</p>
    </div>
  );
}

export function InlineError(props: { message: string }): ReactNode {
  return (
    <Alert variant="destructive" className="inline-error">
      <CircleAlert size={16} />
      <AlertDescription>{props.message}</AlertDescription>
    </Alert>
  );
}

export function FormStatus(props: { message: string }): ReactNode {
  return (
    <Alert className="status-alert" role="status">
      <AlertDescription>{props.message}</AlertDescription>
    </Alert>
  );
}

export function StatusDot(props: { ok: boolean }): ReactNode {
  return <span className={props.ok ? "status-dot ok" : "status-dot error"} />;
}

export const themeOptions = [
  { value: "auto", labelKey: "shell.themeMode.auto", icon: Monitor },
  { value: "light", labelKey: "shell.themeMode.light", icon: Sun },
  { value: "dark", labelKey: "shell.themeMode.dark", icon: Moon },
] as const;

export function ThemeControl(props: { theme: ThemeMode; onThemeChange(theme: ThemeMode): void }): ReactNode {
  const t = useTranslate();

  return (
    <div className="theme-control" aria-label={t("shell.theme")}>
      <span>{t("shell.theme")}</span>
      <div className="theme-segmented-control" role="radiogroup" aria-label={t("shell.theme")}>
        {themeOptions.map((item) => {
          const Icon = item.icon;
          const selected = props.theme === item.value;
          return (
            <button
              key={item.value}
              type="button"
              className={selected ? "theme-segment active" : "theme-segment"}
              role="radio"
              aria-checked={selected}
              aria-label={t(item.labelKey)}
              title={t(item.labelKey)}
              onClick={() => props.onThemeChange(item.value)}
            >
              <Icon size={14} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function LanguageSelect(): ReactNode {
  const t = useTranslate();
  const i18n = useI18n();
  const lang = useLang() as AppLang;

  function switchLang(nextLang: AppLang): void {
    persistLang(nextLang);
    void i18n.switchLang(nextLang);
  }

  return (
    <div className="language-select">
      <span className="language-select-label">{t("language.label")}</span>
      <Select value={lang} onValueChange={(value) => switchLang(value as AppLang)}>
        <SelectTrigger className="language-select-trigger" size="sm" aria-label={t("language.label")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="language-select-content" position="popper" align="start">
          {supportedLangs.map((item) => (
            <SelectItem key={item} value={item}>
              {t(`language.${item}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
