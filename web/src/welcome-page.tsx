import type { AppData, PactIdentityResponse, RunLogPage, RuntimeTokenCreation, RuntimeTokenSummary } from "./model";
import type { ReactNode } from "react";

import { useTranslate } from "@embra/i18n/react";
import { useClipboard } from "foxact/use-clipboard";
import { ArrowLeft, Bot, Cable, Check, CheckCircle2, Copy, KeyRound, Loader2, Plus, Signature } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { apiGet, apiPost } from "./api";
import { buildMcpClientConfig } from "./client-onboarding";
import { CopyButton } from "./components/copy-field";
import { isNoAuthOnlyProvider, isUsableCredentialConnection, sortProviders } from "./model";
import { InlineError, ProviderIcon } from "./shared-ui";
import { writeWelcomeDismissed } from "./welcome-state";
import { Button } from "@/components/ui/button";

interface WelcomePageProps {
  data: AppData;
  gatewayUrl: string;
  onRefresh(): void;
}

// How often the agent step asks whether the new token made its first call.
const pollMs = 3000;
// Suggested services shown on the connect step; the full catalog stays one
// link away.
const suggestedServiceLimit = 8;

export type AgentKind = "mcp" | "token" | "pact";

// The first-run flow (PAP's /welcome): step one adds an agent the way that
// agent connects (MCP server + client config, a copy-once API token, or a
// PACT delegation link), step two connects a first service through the normal
// connect flow (permission confirm included), step three lands on Overview.
// Pure UI state over existing endpoints; dismissing stores a localStorage
// flag so the guide stays out of the way afterwards.
export function WelcomePage(props: WelcomePageProps): ReactNode {
  const t = useTranslate();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [pactAvailable, setPactAvailable] = useState<boolean | null>(null);

  const stepParam = searchParams.get("step");
  const step: 1 | 2 | 3 = stepParam === "2" ? 2 : stepParam === "3" ? 3 : 1;
  const addedId = searchParams.get("added") ?? undefined;
  const tokens = props.data.runtimeTokens;
  const connections = useMemo(
    () =>
      props.data.connections.filter((connection) => connection.id != null && isUsableCredentialConnection(connection)),
    [props.data.connections],
  );

  // `?dismissed` marks the guide done and gets out of the way.
  useEffect(() => {
    if (searchParams.get("dismissed") != null) {
      writeWelcomeDismissed();
      navigate("/overview", { replace: true });
    }
  }, [searchParams, navigate]);

  // PACT delegation is flag-gated server-side: probe the existing endpoint
  // once — a 404 means the tile stays hidden.
  useEffect(() => {
    let cancelled = false;
    apiGet<PactIdentityResponse>("/api/pact/identity")
      .then(() => {
        if (!cancelled) setPactAvailable(true);
      })
      .catch(() => {
        if (!cancelled) setPactAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function dismiss(): void {
    writeWelcomeDismissed();
    navigate("/overview");
  }

  function goToStep(next: 1 | 2 | 3, extra?: string): void {
    navigate(`/welcome?step=${next}${extra ?? ""}`);
  }

  return (
    <section className="detail-panel welcome-panel">
      <ol className="welcome-stepper" aria-label={t("welcome.stepsLabel")}>
        {[1, 2, 3].map((index) => (
          <li
            key={index}
            className="welcome-step"
            data-state={index < step ? "done" : index === step ? "active" : "pending"}
            aria-current={index === step ? "step" : undefined}
          >
            <span className="welcome-step-index">{index < step ? <Check size={12} /> : index}</span>
            <span className="welcome-step-name">{t(`welcome.steps.${index}`)}</span>
          </li>
        ))}
      </ol>

      {step === 1 ? (
        <AgentStep
          tokens={tokens}
          gatewayUrl={props.gatewayUrl}
          pactAvailable={pactAvailable === true}
          onRefresh={props.onRefresh}
          onDone={() => goToStep(2)}
        />
      ) : null}
      {step === 2 ? (
        <ServiceStep
          data={props.data}
          connections={connections}
          onDone={() => goToStep(3)}
          onBack={() => goToStep(1)}
        />
      ) : null}
      {step === 3 ? (
        <DoneStep
          tokens={tokens}
          connections={connections}
          addedId={addedId}
          onConnectAnother={() => goToStep(2)}
          onOpenOverview={() => {
            writeWelcomeDismissed();
            navigate(`/overview${addedId ? `?added=${encodeURIComponent(addedId)}` : ""}`);
          }}
        />
      ) : null}

      {step < 3 ? (
        <button type="button" className="welcome-skip" onClick={dismiss}>
          {t("welcome.skip")}
        </button>
      ) : null}
    </section>
  );
}

interface CreatedToken {
  id: string;
  secret: string;
}

// Step 1 — pick how the agent connects. Choosing MCP or API token creates the
// runtime token on the spot (copy-once secret); each variant then polls for
// the token's first authenticated call and advances on its own.
function AgentStep(props: {
  tokens: RuntimeTokenSummary[];
  gatewayUrl: string;
  pactAvailable: boolean;
  onRefresh(): void;
  onDone(): void;
}): ReactNode {
  const t = useTranslate();
  const { copy, copied } = useClipboard();
  const [kind, setKind] = useState<AgentKind | null>(null);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [firstCall, setFirstCall] = useState(false);
  const createdIdRef = useRef<string | null>(null);
  const advancedRef = useRef(false);
  const hasAgent = props.tokens.length > 0;

  // Poll for the token's first authenticated call: any run carrying its id.
  useEffect(() => {
    const id = createdIdRef.current;
    if (!id || firstCall) {
      return;
    }
    const timer = window.setInterval(() => {
      void apiGet<RunLogPage>("/api/runs")
        .then((page) => {
          if (page.items.some((run) => run.runtimeTokenId === id)) {
            setFirstCall(true);
          }
        })
        .catch(() => {
          // A failed poll just retries on the next tick.
        });
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [created, firstCall]);

  // First call seen: show the success beat briefly, then advance. `onDone`
  // changes identity each render, so it is read through a ref instead of the
  // effect deps — a re-render must not restart the timer.
  const onDoneRef = useRef(props.onDone);
  onDoneRef.current = props.onDone;
  useEffect(() => {
    if (!firstCall || advancedRef.current) {
      return;
    }
    advancedRef.current = true;
    const timer = window.setTimeout(() => onDoneRef.current(), 1200);
    return () => window.clearTimeout(timer);
  }, [firstCall]);

  async function choose(next: AgentKind): Promise<void> {
    setKind(next);
    setError(null);
    if (next === "pact" || createdIdRef.current) {
      return;
    }
    setPending(true);
    try {
      const result = await apiPost<RuntimeTokenCreation>("/api/runtime-tokens", {
        name: next === "mcp" ? "mcp-agent" : "api-agent",
      });
      createdIdRef.current = result.record.id;
      setCreated({ id: result.record.id, secret: result.token });
      props.onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("welcome.agent.createFailed"));
      setKind(null);
    } finally {
      setPending(false);
    }
  }

  if (hasAgent && !created) {
    return (
      <StepBody title={t("welcome.agent.title")} description={t("welcome.agent.existing")}>
        <div className="button-row">
          <Button onClick={props.onDone}>{t("welcome.continue")}</Button>
        </div>
      </StepBody>
    );
  }

  if (!kind) {
    return (
      <StepBody title={t("welcome.agent.title")} description={t("welcome.agent.description")}>
        <div className="welcome-agent-grid">
          <AgentKindTile
            icon={<Cable size={18} />}
            name={t("welcome.agent.mcp.name")}
            description={t("welcome.agent.mcp.description")}
            disabled={pending}
            onChoose={() => void choose("mcp")}
          />
          <AgentKindTile
            icon={<KeyRound size={18} />}
            name={t("welcome.agent.token.name")}
            description={t("welcome.agent.token.description")}
            disabled={pending}
            onChoose={() => void choose("token")}
          />
          {props.pactAvailable ? (
            <AgentKindTile
              icon={<Signature size={18} />}
              name={t("welcome.agent.pact.name")}
              description={t("welcome.agent.pact.description")}
              disabled={pending}
              onChoose={() => void choose("pact")}
            />
          ) : null}
        </div>
        {pending ? (
          <p className="welcome-waiting">
            <Loader2 className="spin" size={14} />
            {t("welcome.agent.creating")}
          </p>
        ) : null}
        {error ? <InlineError message={error} /> : null}
      </StepBody>
    );
  }

  const mcpUrl = `${props.gatewayUrl}/mcp`;
  // Paste-ready config: substitute the real token for the placeholder.
  const mcpConfig = created
    ? buildMcpClientConfig(props.gatewayUrl, true).replace("<RUNTIME_TOKEN>", created.secret)
    : "";
  const waiting = created != null && !firstCall;
  const another = (
    <Button variant="outline" disabled={pending} onClick={() => setKind(null)}>
      <ArrowLeft size={15} />
      {t("welcome.agent.chooseAnother")}
    </Button>
  );

  return (
    <StepBody title={t(`welcome.agent.${kind}.title`)} description={t(`welcome.agent.${kind}.lead`)}>
      {kind === "mcp" && created ? (
        <>
          <ol className="welcome-instructions">
            <li>{t("welcome.agent.mcp.steps.add")}</li>
            <li>{t("welcome.agent.mcp.steps.paste")}</li>
            <li>{t("welcome.agent.mcp.steps.call")}</li>
          </ol>
          <CopyLine
            label={t("welcome.agent.mcp.serverUrl")}
            value={mcpUrl}
            copyLabel={t("welcome.agent.mcp.copyUrl")}
          />
          <div className="agent-credential">
            <span className="agent-credential-label">
              {t("welcome.agent.mcp.config")}
              <CopyButton value={mcpConfig} label={t("welcome.agent.mcp.copyConfig")} />
            </span>
            <pre className="agent-config">{mcpConfig}</pre>
          </div>
        </>
      ) : null}
      {kind === "token" && created ? (
        <div className="agent-credential">
          <span className="agent-credential-label">{t("welcome.agent.token.secret")}</span>
          <div className="agent-secret">
            <code className="agent-secret-value">{created.secret}</code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copy(created.secret)}
              aria-label={copied ? t("access.copiedToken") : t("access.copyToken")}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? t("access.copiedToken") : t("access.copyToken")}
            </Button>
          </div>
          <small>{t("welcome.agent.token.shownOnce")}</small>
        </div>
      ) : null}
      {kind === "pact" ? (
        <div className="welcome-pact-card">
          <p className="muted-copy">{t("welcome.agent.pact.hint")}</p>
          <Button asChild variant="outline" size="sm">
            <Link to="/pact">
              <Signature size={15} />
              {t("welcome.agent.pact.open")}
            </Link>
          </Button>
        </div>
      ) : null}
      {!created && kind !== "pact" ? (
        <p className="welcome-waiting">
          <Loader2 className="spin" size={14} />
          {t("welcome.agent.creating")}
        </p>
      ) : null}
      {error ? <InlineError message={error} /> : null}
      {waiting || firstCall ? (
        <p className="welcome-waiting" aria-live="polite">
          {firstCall ? (
            <>
              <CheckCircle2 size={14} className="welcome-waiting-ok" />
              {t("welcome.agent.firstCall")}
            </>
          ) : (
            <>
              <Loader2 className="spin" size={14} />
              {t("welcome.agent.waiting")}
            </>
          )}
        </p>
      ) : null}
      <div className="button-row">
        {another}
        <Button onClick={props.onDone}>{t("welcome.continue")}</Button>
      </div>
    </StepBody>
  );
}

function AgentKindTile(props: {
  icon: ReactNode;
  name: string;
  description: string;
  disabled: boolean;
  onChoose(): void;
}): ReactNode {
  return (
    <button type="button" className="welcome-agent-tile" disabled={props.disabled} onClick={props.onChoose}>
      <span className="welcome-agent-tile-icon">{props.icon}</span>
      <span className="welcome-agent-tile-name">{props.name}</span>
      <span className="welcome-agent-tile-description">{props.description}</span>
    </button>
  );
}

// Step 2 — compact provider pick jumping into the real connect flow (the
// `?welcome=1` hand-off returns here after the permission confirm).
function ServiceStep(props: {
  data: AppData;
  connections: { id?: string }[];
  onDone(): void;
  onBack(): void;
}): ReactNode {
  const t = useTranslate();
  const suggestions = useMemo(() => {
    const connectionsByService = new Map(props.data.connections.map((connection) => [connection.service, connection]));
    return sortProviders(props.data.providers, connectionsByService)
      .filter((provider) => provider.service !== "pact" && !isNoAuthOnlyProvider(provider))
      .filter((provider) => !props.data.connections.some((connection) => connection.service === provider.service))
      .slice(0, suggestedServiceLimit);
  }, [props.data.providers, props.data.connections]);

  return (
    <StepBody title={t("welcome.service.title")} description={t("welcome.service.description")}>
      {props.connections.length > 0 ? (
        <p className="welcome-success-line">
          <CheckCircle2 size={14} />
          {t("welcome.service.connected", { count: props.connections.length })}
        </p>
      ) : null}
      <ul className="welcome-provider-list">
        {suggestions.map((provider) => (
          <li key={provider.service}>
            <Link to={`/providers/${provider.service}?welcome=1`} className="welcome-provider-row">
              <ProviderIcon provider={provider} />
              <span className="welcome-provider-name">{provider.displayName}</span>
              <Plus size={15} className="welcome-provider-add" />
            </Link>
          </li>
        ))}
      </ul>
      <Link className="welcome-catalog-link" to="/providers">
        {t("welcome.service.browseAll")}
      </Link>
      <div className="button-row">
        <Button variant="outline" onClick={props.onBack}>
          <ArrowLeft size={15} />
          {t("welcome.back")}
        </Button>
        <Button onClick={props.onDone}>
          {props.connections.length === 0 ? t("welcome.service.skip") : t("welcome.service.finish")}
        </Button>
      </div>
    </StepBody>
  );
}

// Step 3 — done: what got set up, then land on Overview (`?added` keeps the
// success banner convention the connections page uses).
function DoneStep(props: {
  tokens: RuntimeTokenSummary[];
  connections: { id?: string; service?: string }[];
  addedId?: string;
  onConnectAnother(): void;
  onOpenOverview(): void;
}): ReactNode {
  const t = useTranslate();
  return (
    <StepBody title={t("welcome.done.title")} description={t("welcome.done.description")}>
      <div className="welcome-done-card">
        <CheckCircle2 size={28} className="welcome-done-icon" />
        <ul className="welcome-done-lines">
          <li>
            <Bot size={14} />
            {props.tokens.length > 0 ? t("welcome.done.agentReady") : t("welcome.done.agentSkipped")}
          </li>
          <li>
            <Cable size={14} />
            {props.connections.length > 0
              ? t("welcome.done.connectionsReady", { count: props.connections.length })
              : t("welcome.done.connectionsSkipped")}
          </li>
        </ul>
      </div>
      <div className="button-row">
        <Button onClick={props.onOpenOverview}>
          <Check size={15} />
          {t("welcome.done.openOverview")}
        </Button>
        <Button variant="outline" onClick={props.onConnectAnother}>
          {t("welcome.done.connectAnother")}
        </Button>
        <Button asChild variant="ghost">
          <Link to="/agents">{t("welcome.done.setAccess")}</Link>
        </Button>
      </div>
    </StepBody>
  );
}

function StepBody(props: { title: string; description: string; children: ReactNode }): ReactNode {
  return (
    <div className="welcome-step-body">
      <h2 className="welcome-title">{props.title}</h2>
      <p className="welcome-description">{props.description}</p>
      {props.children}
    </div>
  );
}

// One value to copy (server address, etc.): label, monospace value, copy
// button — PAP's CopyLine, matching the console's copy-field conventions.
function CopyLine(props: { label: string; value: string; copyLabel: string }): ReactNode {
  return (
    <div className="welcome-copy-line">
      <span className="welcome-copy-label">{props.label}</span>
      <code className="welcome-copy-value">{props.value}</code>
      <CopyButton value={props.value} label={props.copyLabel} />
    </div>
  );
}
