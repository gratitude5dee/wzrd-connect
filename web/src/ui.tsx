import type { AppLang } from "./i18n";
import type {
  AppData,
  ApprovalListPage,
  ConnectionRecord,
  OAuthConfig,
  ProviderDefinition,
  RunLogPage,
  RuntimePolicyState,
  RuntimeTokenSummary,
} from "./model";
import type { ThemeMode } from "./theme";
import type { LucideIcon } from "lucide-react";
import type { ReactNode, SubmitEvent } from "react";

import { useI18n, useLang, useTranslate } from "@embra/i18n/react";
import {
  Activity,
  BookOpen,
  Cable,
  Fingerprint,
  Home,
  Bot,
  Loader2,
  LogOut,
  Monitor,
  Moon,
  PanelLeft,
  Plug,
  RefreshCw,
  Settings,
  ShieldCheck,
  Signature,
  Sun,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, matchPath, Navigate, NavLink, Route, Routes, useLocation, useParams } from "react-router";
import { ActionsPage } from "./actions-page";
import { ActivityPage } from "./activity-page";
import { AgentPage } from "./agent-page";
import { AgentsPage } from "./agents-page";
import { ApiError, apiGet, apiPost } from "./api";
import { ApprovalsPage } from "./approvals-page";
import oomolConnectLogoUrl from "./assets/oomol-connect-logo.png";
import { normalizeGatewayUrl } from "./client-onboarding";
import { ConnectionPage } from "./connection-page";
import { ConnectionsPage } from "./connections-page";
import { persistLang, supportedLangs } from "./i18n";
import { createOverviewSummary, emptyData } from "./model";
import { OAuthAppsPage } from "./oauth-apps-page";
import { OverviewPage } from "./overview-page";
import { PactPage } from "./pact-page";
import { ProvidersPage } from "./providers-page";
import { ResourcesPage } from "./resources-page";
import { InlineError, StatusDot } from "./shared-ui";
import { readSidebarExpanded, writeSidebarExpanded } from "./sidebar-state";
import { useThemeMode } from "./theme";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface NavItem {
  path: string;
  labelKey: string;
  icon: LucideIcon;
  badge?: boolean;
}

interface NavGroup {
  labelKey: string;
  items: readonly NavItem[];
}

const navGroups: readonly NavGroup[] = [
  {
    labelKey: "shell.navGroup.operate",
    items: [
      { path: "/overview", labelKey: "nav.overview", icon: Home },
      { path: "/providers", labelKey: "nav.providers", icon: Cable },
      { path: "/connections", labelKey: "nav.connections", icon: Plug },
      { path: "/actions", labelKey: "nav.actions", icon: TerminalSquare },
      { path: "/activity", labelKey: "nav.activity", icon: Activity },
    ],
  },
  {
    labelKey: "shell.navGroup.custody",
    items: [
      { path: "/agents", labelKey: "nav.agents", icon: Bot },
      { path: "/approvals", labelKey: "nav.approvals", icon: ShieldCheck, badge: true },
      { path: "/pact", labelKey: "nav.pact", icon: Signature },
      { path: "/oauth-apps", labelKey: "nav.oauthApps", icon: Fingerprint },
      { path: "/resources", labelKey: "nav.docs", icon: BookOpen },
    ],
  },
] as const;

const oauthCompletionChannelName = "oomol-connect-oauth";
const oauthCompletedType = "oauth.completed";

const themeOptions = [
  { value: "auto", labelKey: "shell.themeMode.auto", icon: Monitor },
  { value: "light", labelKey: "shell.themeMode.light", icon: Sun },
  { value: "dark", labelKey: "shell.themeMode.dark", icon: Moon },
] as const;

export interface AuthSession {
  adminAuthConfigured: boolean;
  authenticated: boolean;
}

export interface OAuthCompletionMessage {
  type: typeof oauthCompletedType;
  service: string;
}

export function subscribeToOAuthCompletions(onComplete: (message: OAuthCompletionMessage) => void): () => void {
  const handleMessage = (event: MessageEvent<unknown>): void => {
    if (isOAuthCompletionMessage(event.data)) {
      onComplete(event.data);
    }
  };

  if (typeof BroadcastChannel === "undefined") {
    return () => {};
  }

  const channel = new BroadcastChannel(oauthCompletionChannelName);
  channel.addEventListener("message", handleMessage);
  return () => channel.close();
}

function isOAuthCompletionMessage(value: unknown): value is OAuthCompletionMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value as { type?: unknown; service?: unknown };
  return message.type === oauthCompletedType && typeof message.service === "string";
}

export interface LogoutState {
  authSession: AuthSession;
}

export function nextLogoutState(state: LogoutState, succeeded: boolean): LogoutState {
  return succeeded
    ? {
        authSession: { ...state.authSession, authenticated: false },
      }
    : state;
}

export interface AuthLoadState {
  pendingUnlockToken: string;
  authSession: AuthSession;
  locked: boolean;
}

export function nextAuthLoadState(state: AuthLoadState, session: AuthSession): AuthLoadState {
  return {
    pendingUnlockToken: session.authenticated ? "" : state.pendingUnlockToken,
    authSession: session,
    locked: !session.authenticated,
  };
}

export interface RuntimeLoadResult {
  authSession: AuthSession;
  data: AppData;
}

/**
 * Loads dashboard state.
 *
 * The provider catalog is generated at build time and cannot change while the
 * server runs, so `cachedProviders` lets refreshes skip re-downloading it and
 * re-fetch only mutable data.
 */
export async function loadRuntimeData(
  unlockToken: string,
  cachedProviders?: ProviderDefinition[],
): Promise<RuntimeLoadResult> {
  const authSession = await apiGet<AuthSession>("/api/auth/session", unlockToken);
  if (!authSession.authenticated) {
    return { authSession, data: emptyData };
  }

  const catalogRequest =
    cachedProviders !== undefined
      ? Promise.resolve(cachedProviders)
      : apiGet<(ProviderDefinition & { setup: ProviderDefinition["auth"] })[]>("/api/providers").then((providers) =>
          providers.map(({ setup, ...provider }) => ({ ...provider, auth: setup })),
        );

  const [
    providers,
    connections,
    oauthConfigs,
    runtimeTokens,
    runtimePolicy,
    runPage,
    marketplace,
    providerPreferences,
    pendingApprovals,
  ] = await Promise.all([
    catalogRequest,
    apiGet<ConnectionRecord[]>("/api/connections"),
    apiGet<OAuthConfig[]>("/api/oauth/configs"),
    apiGet<RuntimeTokenSummary[]>("/api/runtime-tokens"),
    apiGet<RuntimePolicyState>("/api/runtime-policy"),
    apiGet<RunLogPage>("/api/runs"),
    apiGet<import("./model").MarketplaceState>("/api/marketplace"),
    apiGet<import("./model").ProviderPreference[]>("/api/provider-preferences"),
    // Older runtimes may not serve the approvals API; the badge just stays at 0.
    apiGet<ApprovalListPage>("/api/approvals?status=pending")
      .then((page) => page.items.length)
      .catch(() => 0),
  ]);

  return {
    authSession,
    data: {
      providers,
      connections,
      oauthConfigs,
      runtimeTokens,
      runtimePolicy,
      runs: runPage.items,
      runsNextCursor: runPage.nextCursor,
      marketplace,
      providerPreferences,
      pendingApprovals,
    },
  };
}

export function App(): ReactNode {
  const t = useTranslate();
  const { theme, setTheme } = useThemeMode();
  const [data, setData] = useState<AppData>(emptyData);
  const [authSession, setAuthSession] = useState<AuthSession>({
    adminAuthConfigured: false,
    authenticated: true,
  });
  const pendingUnlockToken = useRef("");
  // Catalog is immutable while the server runs, so it is fetched once and
  // reused across refreshes instead of being re-downloaded on every action.
  const cachedProviders = useRef<ProviderDefinition[] | undefined>(undefined);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [runtimeChecked, setRuntimeChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(
    () =>
      subscribeToOAuthCompletions(() => {
        setRefreshToken((value) => value + 1);
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const requestUnlockToken = pendingUnlockToken.current;
    setLoading(true);
    loadRuntimeData(requestUnlockToken, cachedProviders.current)
      .then(({ authSession: session, data: nextData }) => {
        if (!cancelled) {
          cachedProviders.current = session.authenticated ? nextData.providers : undefined;
          const nextAuth = nextAuthLoadState(
            {
              pendingUnlockToken: pendingUnlockToken.current,
              authSession,
              locked,
            },
            session,
          );
          pendingUnlockToken.current = nextAuth.pendingUnlockToken;
          setData(nextData);
          setAuthSession(nextAuth.authSession);
          setLocked(nextAuth.locked);
          setError(session.authenticated ? null : requestUnlockToken.trim() ? t("shell.invalidUnlockToken") : null);
        }
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return;
        }
        if (caught instanceof ApiError && caught.status === 401) {
          pendingUnlockToken.current = "";
          cachedProviders.current = undefined;
          setData(emptyData);
          setAuthSession({ adminAuthConfigured: true, authenticated: false });
          setLocked(true);
          setError(requestUnlockToken.trim() ? t("shell.invalidUnlockToken") : null);
          return;
        }
        setError(caught instanceof Error ? caught.message : t("shell.loadRuntimeFailed"));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setRuntimeChecked(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [refreshToken, t]);

  function refresh(): void {
    setRefreshToken((value) => value + 1);
  }

  function unlock(token: string): void {
    pendingUnlockToken.current = token;
    setLoading(true);
    refresh();
  }

  function logout(): void {
    void apiPost("/api/auth/logout", {})
      .then(() => {
        const next = nextLogoutState({ authSession }, true);
        setAuthSession(next.authSession);
        setError(null);
        refresh();
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : t("shell.logoutFailed"));
      });
  }

  if (locked) {
    return <UnlockView loading={loading} message={error} theme={theme} onThemeChange={setTheme} onUnlock={unlock} />;
  }

  if (!runtimeChecked) {
    return <InitialLoadingView />;
  }

  return (
    <AppShell
      data={data}
      showLogout={authSession.adminAuthConfigured && authSession.authenticated}
      loading={loading}
      error={error}
      theme={theme}
      onRefresh={refresh}
      onThemeChange={setTheme}
      onLogout={logout}
    />
  );
}

function InitialLoadingView(): ReactNode {
  const t = useTranslate();

  return (
    <main className="unlock-screen">
      <div className="loading-panel">
        <Loader2 className="spin" size={16} />
        {t("common.loadingRuntimeData")}
      </div>
    </main>
  );
}

interface HeaderDetail {
  key: string;
  count: number;
}

// The muted tabular-nums detail beside the page title, where the loaded data
// already carries a meaningful count (PAP's "Connections · 7 connected").
function headerDetailForSection(section: string | undefined, data: AppData): HeaderDetail | null {
  const summary = createOverviewSummary(data);
  switch (section) {
    case "overview":
    case "providers":
    case "connections":
      return { key: "shell.detail.connected", count: summary.connectedCount };
    case "actions":
      return { key: "shell.detail.actions", count: summary.actionCount };
    case "activity":
      return { key: "shell.detail.requests", count: data.runs.length };
    case "runs":
      return { key: "shell.detail.recent", count: data.runs.length };
    case "approvals":
      return { key: "shell.detail.pending", count: data.pendingApprovals ?? 0 };
    case "agents":
      return { key: "shell.detail.agents", count: summary.activeTokenCount };
    case "oauth-apps":
      return { key: "shell.detail.configured", count: data.oauthConfigs.length };
    default:
      return null;
  }
}

function AppShell(props: {
  data: AppData;
  showLogout: boolean;
  loading: boolean;
  error: string | null;
  theme: ThemeMode;
  onRefresh(): void;
  onThemeChange(theme: ThemeMode): void;
  onLogout(): void;
}): ReactNode {
  const t = useTranslate();
  const location = useLocation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The rail is the default; the cookie remembers an explicit expansion.
  const [sidebarExpanded, setSidebarExpanded] = useState(() => readSidebarExpanded());
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [clientGatewayUrl, setClientGatewayUrl] = useState(() =>
    typeof window === "undefined" ? "http://localhost:3000" : window.location.origin,
  );
  const clientBaseUrl =
    normalizeGatewayUrl(clientGatewayUrl) ??
    (typeof window === "undefined" ? "http://localhost:3000" : window.location.origin);
  const connectionSettingsParams = new URLSearchParams(location.pathname === "/providers" ? location.search : "");
  connectionSettingsParams.set("onekey", "overview");
  connectionSettingsParams.delete("features");
  const connectionSettingsUrl = `/providers?${connectionSettingsParams}`;
  const heading = headingForPath(location.pathname);
  const section = location.pathname.split("/").filter(Boolean)[0];
  const isOverviewPage = heading === "overview";
  const isBrowserPage = section === "actions";
  const mainClassName = [isBrowserPage ? "main main-browser" : "main", isOverviewPage ? "overview-main" : ""]
    .filter(Boolean)
    .join(" ");
  const headerDetail = useMemo(() => headerDetailForSection(section, props.data), [section, props.data]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "b") {
        return;
      }
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable]")) {
        return;
      }
      event.preventDefault();
      setSidebarExpanded((expanded) => {
        writeSidebarExpanded(!expanded);
        return !expanded;
      });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function toggleSidebar(): void {
    setSidebarExpanded((expanded) => {
      writeSidebarExpanded(!expanded);
      return !expanded;
    });
  }

  function onSidebarTrigger(): void {
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 960px)").matches) {
      setMobileNavOpen(true);
    } else {
      toggleSidebar();
    }
  }

  const rail = !sidebarExpanded;

  return (
    <TooltipProvider delayDuration={120}>
      <div className="app-shell" data-sidebar={rail ? "rail" : "expanded"}>
        {mobileNavOpen ? (
          <div className="sidebar-backdrop" aria-hidden="true" onClick={() => setMobileNavOpen(false)} />
        ) : null}
        <aside className="sidebar" data-mobile-open={mobileNavOpen ? true : undefined}>
          <div className="brand">
            <img className="brand-mark" src={oomolConnectLogoUrl} alt="" />
            <div className="brand-text">
              <div className="brand-name">WZRD Connect</div>
              <div className="brand-subtitle">{t("brand.subtitle")}</div>
            </div>
          </div>

          <div className="sidebar-content">
            <nav className="sidebar-nav" aria-label={t("shell.primaryNav")}>
              {navGroups.map((group) => (
                <div className="nav-group" key={group.labelKey}>
                  <div className="nav-group-label">{t(group.labelKey)}</div>
                  {group.items.map((item) => {
                    const badge = item.badge === true ? (props.data.pendingApprovals ?? 0) : 0;
                    return (
                      <ShellNavItem
                        key={item.path}
                        item={item}
                        label={t(item.labelKey)}
                        badge={badge}
                        rail={rail}
                        onNavigate={() => setMobileNavOpen(false)}
                      />
                    );
                  })}
                </div>
              ))}
            </nav>
          </div>

          <div className="sidebar-footer">
            <ThemeMenuButton theme={props.theme} onThemeChange={props.onThemeChange} rail={rail} />
            {props.showLogout ? (
              <ShellFooterButton icon={LogOut} label={t("shell.logout")} rail={rail} onClick={props.onLogout} />
            ) : null}
          </div>
        </aside>

        <div className={isBrowserPage ? "main-region main-region-browser" : "main-region"}>
          <header className="shell-header">
            <div className="shell-header-title">
              <Button
                variant="ghost"
                size="icon-sm"
                className="sidebar-trigger"
                aria-label={t("shell.menu")}
                title={t("shell.menu")}
                onClick={onSidebarTrigger}
              >
                <PanelLeft size={18} aria-hidden="true" />
              </Button>
              <h1>{t(`shell.headings.${heading}.title`)}</h1>
              {headerDetail ? (
                <span className="shell-header-detail">{t(headerDetail.key, { count: headerDetail.count })}</span>
              ) : null}
            </div>
            <div className="shell-header-actions">
              {props.loading ? (
                <div className="loading-panel page-loading">
                  <Loader2 className="spin" size={16} />
                  {t("common.loadingRuntimeData")}
                </div>
              ) : null}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("shell.settings")}
                aria-haspopup="dialog"
                aria-expanded={settingsOpen}
                title={t("shell.settings")}
                onClick={() => setSettingsOpen(true)}
              >
                <Settings size={18} aria-hidden="true" />
              </Button>
            </div>
            <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
              <DialogContent className="console-settings-panel">
                <DialogHeader>
                  <DialogTitle>{t("shell.settings")}</DialogTitle>
                  <DialogDescription>{t("shell.settingsDescription")}</DialogDescription>
                </DialogHeader>
                <div className="console-settings-controls">
                  <LanguageSelect />
                </div>
                <div className="console-settings-section">
                  <Button asChild variant="outline">
                    <Link to={connectionSettingsUrl} onClick={() => setSettingsOpen(false)}>
                      <Cable size={15} aria-hidden="true" />
                      {t("providers.hostedAccess.restore")}
                    </Link>
                  </Button>
                  <p className="console-settings-feature-description">{t("shell.oomolKeyDescription")}</p>
                </div>
                <div className="console-settings-runtime">
                  <div className="runtime-status">
                    <StatusDot ok={!props.error} />
                    <span>{props.error ? t("common.apiUnavailable") : t("common.runtimeReady")}</span>
                  </div>
                  <Button variant="outline" size="sm" onClick={props.onRefresh} disabled={props.loading}>
                    {props.loading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
                    {t("common.refresh")}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </header>

          <main className={mainClassName}>
            {props.error ? <InlineError message={props.error} /> : null}

            <Routes>
              <Route index element={<Navigate to="/overview" replace />} />
              <Route path="/overview" element={<OverviewPage data={props.data} onRefresh={props.onRefresh} />} />
              <Route path="/providers" element={<ProvidersPage data={props.data} onRefresh={props.onRefresh} />} />
              <Route path="/marketplace" element={<Navigate to="/providers?onekey=1" replace />} />
              <Route
                path="/providers/:service"
                element={<ProvidersPage data={props.data} onRefresh={props.onRefresh} />}
              />
              <Route path="/connections" element={<ConnectionsPage data={props.data} onRefresh={props.onRefresh} />} />
              <Route
                path="/connections/:connectionId"
                element={<ConnectionPage data={props.data} onRefresh={props.onRefresh} />}
              />
              <Route path="/oauth-apps" element={<OAuthAppsPage data={props.data} onRefresh={props.onRefresh} />} />
              <Route
                path="/actions"
                element={<ActionsPage data={props.data} gatewayUrl={clientBaseUrl} onRefresh={props.onRefresh} />}
              />
              <Route
                path="/actions/:actionId"
                element={<ActionsPage data={props.data} gatewayUrl={clientBaseUrl} onRefresh={props.onRefresh} />}
              />
              <Route
                path="/activity"
                element={
                  <ActivityPage
                    initialRuns={props.data.runs}
                    runsNextCursor={props.data.runsNextCursor}
                    connections={props.data.connections}
                    runtimeTokens={props.data.runtimeTokens}
                  />
                }
              />
              <Route
                path="/runs"
                element={
                  <ActivityPage
                    initialRuns={props.data.runs}
                    runsNextCursor={props.data.runsNextCursor}
                    connections={props.data.connections}
                    runtimeTokens={props.data.runtimeTokens}
                    preset="run"
                  />
                }
              />
              <Route path="/approvals" element={<ApprovalsPage onRefresh={props.onRefresh} />} />
              <Route path="/approvals/:approvalId" element={<ApprovalsPage onRefresh={props.onRefresh} />} />
              <Route path="/pact" element={<PactPage onRefresh={props.onRefresh} />} />
              <Route
                path="/agents"
                element={
                  <AgentsPage
                    providers={props.data.providers}
                    connections={props.data.connections}
                    tokens={props.data.runtimeTokens}
                    policy={props.data.runtimePolicy ?? emptyData.runtimePolicy!}
                    runs={props.data.runs}
                    onRefresh={props.onRefresh}
                  />
                }
              />
              <Route
                path="/agents/:agentId"
                element={<AgentRoute data={props.data} gatewayUrl={clientBaseUrl} onRefresh={props.onRefresh} />}
              />
              <Route path="/access" element={<Navigate to="/agents" replace />} />
              <Route
                path="/resources"
                element={<ResourcesPage gatewayUrl={clientGatewayUrl} onGatewayUrlChange={setClientGatewayUrl} />}
              />
              <Route path="*" element={<Navigate to="/overview" replace />} />
            </Routes>
          </main>
        </div>
        <Toaster
          position="top-right"
          closeButton
          containerAriaLabel={t("shell.notifications")}
          toastOptions={{ closeButtonAriaLabel: t("common.close") }}
        />
      </div>
    </TooltipProvider>
  );
}

export interface UnlockViewProps {
  loading: boolean;
  message: string | null;
  theme: ThemeMode;
  onThemeChange(theme: ThemeMode): void;
  onUnlock(token: string): void;
}

export function UnlockView(props: UnlockViewProps): ReactNode {
  const t = useTranslate();
  const [token, setToken] = useState("");

  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    props.onUnlock(token.trim());
  }

  return (
    <main className="unlock-screen">
      <section className="unlock-panel">
        <div className="brand">
          <img className="brand-mark" src={oomolConnectLogoUrl} alt="" />
          <div>
            <div className="brand-name">WZRD Connect</div>
            <div className="brand-subtitle">{t("brand.adminAccess")}</div>
          </div>
        </div>
        <LanguageSelect />
        <ThemeControl theme={props.theme} onThemeChange={props.onThemeChange} />
        <form className="form-grid" onSubmit={submit}>
          <Label className="field">
            <span>{t("unlock.token")}</span>
            <Input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoFocus
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
        </form>
        {props.message ? (
          <div className="unlock-status" aria-live="polite">
            <InlineError message={props.message} />
          </div>
        ) : null}
      </section>
    </main>
  );
}

function ShellNavItem(props: {
  item: NavItem;
  label: string;
  badge: number;
  rail: boolean;
  onNavigate(): void;
}): ReactNode {
  const Icon = props.item.icon;
  // A static className: Radix Slot (TooltipTrigger asChild) stringifies the
  // function form NavLink accepts, which would drop the nav-item styles.
  const location = useLocation();
  const isActive = matchPath({ path: props.item.path, end: false }, location.pathname) !== null;
  const link = (
    <NavLink className={isActive ? "nav-item active" : "nav-item"} to={props.item.path} onClick={props.onNavigate}>
      <Icon size={16} />
      <span className="nav-item-label">{props.label}</span>
      {props.badge > 0 ? <span className="nav-badge">{props.badge}</span> : null}
    </NavLink>
  );
  if (!props.rail) {
    return link;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{props.label}</TooltipContent>
    </Tooltip>
  );
}

function ShellFooterButton(props: { icon: LucideIcon; label: string; rail: boolean; onClick(): void }): ReactNode {
  const Icon = props.icon;
  const button = (
    <button type="button" className="nav-item sidebar-footer-item" onClick={props.onClick}>
      <Icon size={16} />
      <span className="nav-item-label">{props.label}</span>
    </button>
  );
  if (!props.rail) {
    return button;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{props.label}</TooltipContent>
    </Tooltip>
  );
}

// The footer's compact theme affordance: one click advances auto → light →
// dark, the icon shows the current mode.
function ThemeMenuButton(props: { theme: ThemeMode; onThemeChange(theme: ThemeMode): void; rail: boolean }): ReactNode {
  const t = useTranslate();
  const index = Math.max(
    0,
    themeOptions.findIndex((option) => option.value === props.theme),
  );
  const current = themeOptions[index];
  const next = themeOptions[(index + 1) % themeOptions.length];
  const Icon = current.icon;
  const label = `${t("shell.theme")}: ${t(current.labelKey)}`;
  const button = (
    <button
      type="button"
      className="nav-item sidebar-footer-item"
      onClick={() => props.onThemeChange(next.value)}
      aria-label={label}
    >
      <Icon size={16} />
      <span className="nav-item-label">{label}</span>
    </button>
  );
  if (!props.rail) {
    return button;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function ThemeControl(props: { theme: ThemeMode; onThemeChange(theme: ThemeMode): void }): ReactNode {
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

function LanguageSelect(): ReactNode {
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

function AgentRoute(props: { data: AppData; gatewayUrl: string; onRefresh(): void }): ReactNode {
  const { agentId = "" } = useParams();
  return (
    <AgentPage
      providers={props.data.providers}
      connections={props.data.connections}
      tokens={props.data.runtimeTokens}
      policy={props.data.runtimePolicy ?? emptyData.runtimePolicy!}
      runs={props.data.runs}
      agentId={agentId}
      gatewayUrl={props.gatewayUrl}
      onRefresh={props.onRefresh}
    />
  );
}

function headingForPath(pathname: string): string {
  const section = pathname.split("/").filter(Boolean)[0];
  if (section === "providers") {
    return "providers";
  }
  if (section === "connections") {
    return "connections";
  }
  if (section === "marketplace") {
    return "marketplace";
  }
  if (section === "oauth-apps") {
    return "oauthApps";
  }
  if (section === "actions") {
    return "actions";
  }
  if (section === "activity") {
    return "activity";
  }
  if (section === "runs") {
    return "runs";
  }
  if (section === "approvals") {
    return "approvals";
  }
  if (section === "pact") {
    return "pact";
  }
  if (section === "agents" || section === "access") {
    return "agents";
  }
  if (section === "resources") {
    return "resources";
  }
  return "overview";
}
