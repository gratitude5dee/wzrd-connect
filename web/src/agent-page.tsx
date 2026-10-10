import type {
  ConnectionRecord,
  ProviderDefinition,
  RunLog,
  RuntimePolicyState,
  RuntimeTokenCreation,
  RuntimeTokenSummary,
} from "./model";
import type { PolicyEditorDraft } from "./policy";
import type { ReactNode, SubmitEvent } from "react";

import { useTranslate } from "@embra/i18n/react";
import { useClipboard } from "foxact/use-clipboard";
import { Bot, Check, Copy, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  connectionGrantOptions,
  createConnectionGrantDraft,
  EditTokenPolicyDialog,
  runtimeTokenPolicyBody,
} from "./access-editors";
import { buildAgentAccess, tokenPolicyRules } from "./agent-access";
import { AgentAccessEditor } from "./agent-access-editor";
import { apiDelete, apiPost, apiPut } from "./api";
import { buildMcpClientConfig } from "./client-onboarding";
import { EmptyRows, Row, RowList } from "./components/row-list";
import { formatDate } from "./model";
import { createPolicyEditorDraft, policyRulesFromEditorDraft } from "./policy";
import { Badge, EmptyState, FormStatus, StatusDot } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface AgentPageProps {
  providers: ProviderDefinition[];
  connections: ConnectionRecord[];
  tokens: RuntimeTokenSummary[];
  policy: RuntimePolicyState;
  runs: RunLog[];
  agentId: string;
  gatewayUrl: string;
  onRefresh(): void;
}

const RECENT_RUNS = 8;

export function AgentPage(props: AgentPageProps): ReactNode {
  const t = useTranslate();
  const navigate = useNavigate();
  const location = useLocation();
  const { copy, copied } = useClipboard();
  const token = props.tokens.find((item) => item.id === props.agentId);
  const secret = (location.state as { secret?: string } | null)?.secret;

  const [editOpen, setEditOpen] = useState(false);
  const [editDraft, setEditDraft] = useState<PolicyEditorDraft | null>(null);
  const [editConnections, setEditConnections] = useState(() => createConnectionGrantDraft());
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connectionOptions = useMemo(
    () => connectionGrantOptions(props.connections, props.providers),
    [props.connections, props.providers],
  );
  const recentRuns = useMemo(
    () => props.runs.filter((run) => run.runtimeTokenId === props.agentId).slice(0, RECENT_RUNS),
    [props.runs, props.agentId],
  );
  const mcpUrl = `${props.gatewayUrl}/mcp`;
  const mcpConfig = useMemo(() => buildMcpClientConfig(props.gatewayUrl, true), [props.gatewayUrl]);
  const accessChanged = useMemo(
    () =>
      token
        ? buildAgentAccess({
            token,
            rules: tokenPolicyRules(token),
            allowedConnections: [...token.allowedConnections],
            policy: props.policy,
            providers: props.providers,
            connections: props.connections,
          }).changed
        : 0,
    [token, props.policy, props.providers, props.connections],
  );

  if (!token) {
    return (
      <section className="detail-panel">
        <EmptyState
          icon={<Bot size={20} />}
          title={t("agents.missing.title")}
          description={t("agents.missing.description")}
        />
      </section>
    );
  }

  function openEdit(): void {
    if (!token) {
      return;
    }
    setEditDraft(createPolicyEditorDraft(tokenPolicyRules(token)));
    setEditConnections(createConnectionGrantDraft(token.allowedConnections ?? []));
    setStatus(null);
    setEditOpen(true);
  }

  async function savePolicy(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token || !editDraft) {
      return;
    }
    setStatus(t("access.policy.saving"));
    try {
      await apiPut(
        `/api/runtime-tokens/${token.id}`,
        runtimeTokenPolicyBody(policyRulesFromEditorDraft(editDraft), editConnections),
      );
      setEditOpen(false);
      setStatus(null);
      props.onRefresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("access.policy.saveFailed"));
    }
  }

  async function resetToken(): Promise<void> {
    if (!token) {
      return;
    }
    setBusy(true);
    setConfirmReset(false);
    try {
      const rules = tokenPolicyRules(token);
      const created = await apiPost<RuntimeTokenCreation>("/api/runtime-tokens", {
        name: token.name,
        ...runtimeTokenPolicyBody(rules, createConnectionGrantDraft(token.allowedConnections ?? [])),
      });
      await apiDelete(`/api/runtime-tokens/${token.id}`);
      props.onRefresh();
      navigate(`/agents/${created.record.id}`, { state: { secret: created.token }, replace: true });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("agents.resetFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(): Promise<void> {
    if (!token) {
      return;
    }
    setBusy(true);
    setConfirmRevoke(false);
    try {
      await apiDelete(`/api/runtime-tokens/${token.id}`);
      props.onRefresh();
      navigate("/agents");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("access.revokeFailed"));
      setBusy(false);
    }
  }

  const lastUsed = token.lastUsedAt ?? recentRuns[0]?.completedAt;

  return (
    <section className="detail-panel access-panel">
      <div className="access-section-heading">
        <div>
          <h2>{token.name}</h2>
          <p>{t("agents.detail.description")}</p>
        </div>
        <Button variant="outline" size="sm" type="button" onClick={openEdit}>
          <Pencil size={15} />
          {t("agents.advancedPolicy")}
        </Button>
      </div>
      {status ? <FormStatus message={status} /> : null}

      <section className="agent-signin">
        <h3 className="agent-section-title">{t("agents.signin.title")}</h3>
        <div className="agent-credential">
          <span className="agent-credential-label">{t("agents.signin.token")}</span>
          {secret ? (
            <div className="agent-secret">
              <code className="agent-secret-value">{secret}</code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copy(secret)}
                aria-label={copied ? t("access.copiedToken") : t("access.copyToken")}
              >
                {copied ? <Check size={15} /> : <Copy size={15} />}
                {copied ? t("access.copiedToken") : t("access.copyToken")}
              </Button>
            </div>
          ) : (
            <div className="agent-secret">
              <span className="agent-secret-hidden">{t("agents.signin.hidden")}</span>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirmReset(true)}>
                <RotateCcw size={15} />
                {t("agents.signin.reset")}
              </Button>
            </div>
          )}
          <small>{t(secret ? "agents.signin.shownOnce" : "agents.signin.hiddenHint")}</small>
        </div>
        <div className="agent-credential">
          <span className="agent-credential-label">{t("agents.signin.serverUrl")}</span>
          <div className="agent-secret">
            <code className="agent-secret-value">{mcpUrl}</code>
            <Button variant="outline" size="sm" onClick={() => void copy(mcpUrl)} aria-label={t("agents.signin.copy")}>
              <Copy size={15} />
              {t("agents.signin.copy")}
            </Button>
          </div>
        </div>
        <div className="agent-credential">
          <span className="agent-credential-label">{t("agents.signin.config")}</span>
          <pre className="agent-config">{mcpConfig}</pre>
        </div>
        <div className="agent-meta">
          <span>
            {t("agents.signin.created", { date: formatDate(token.createdAt) })}
            {lastUsed ? ` · ${t("agents.signin.lastUsed", { date: formatDate(lastUsed) })}` : ""}
          </span>
        </div>
      </section>

      <section className="agent-access">
        <div className="agent-section-heading">
          <h3 className="agent-section-title">
            {t("agents.access.title")}
            {accessChanged > 0 ? (
              <Badge tone="warning">{t("agents.access.changedCount", { count: accessChanged })}</Badge>
            ) : null}
          </h3>
        </div>
        <AgentAccessEditor
          token={token}
          tokens={props.tokens}
          policy={props.policy}
          providers={props.providers}
          connections={props.connections}
          onRefresh={props.onRefresh}
        />
      </section>

      <section className="agent-activity">
        <div className="agent-section-heading">
          <h3 className="agent-section-title">{t("agents.activity.title")}</h3>
          <Link to={`/activity?agent=${encodeURIComponent(token.id)}`}>{t("agents.activity.viewAll")}</Link>
        </div>
        <RowList>
          {recentRuns.length === 0 ? (
            <EmptyRows>{t("agents.activity.empty")}</EmptyRows>
          ) : (
            recentRuns.map((run) => (
              <Row
                key={run.id}
                icon={<StatusDot ok={run.ok} />}
                title={run.actionId}
                cells={
                  <>
                    <span className="agents-cell-conn hidden md:block">
                      {run.connectionProfile?.displayName ?? run.service}
                    </span>
                    <span className="agents-cell-time">{formatDate(run.startedAt)}</span>
                  </>
                }
              />
            ))
          )}
        </RowList>
      </section>

      <div className="agent-danger">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirmRevoke(true)}>
          <Trash2 size={15} />
          {t("access.revoke")}
        </Button>
      </div>

      {editOpen && editDraft ? (
        <EditTokenPolicyDialog
          token={token}
          draft={editDraft}
          connections={editConnections}
          connectionOptions={connectionOptions}
          providers={props.providers}
          status={status}
          onDraftChange={setEditDraft}
          onConnectionsChange={setEditConnections}
          onSubmit={savePolicy}
          onClose={() => setEditOpen(false)}
        />
      ) : null}

      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent className="max-w-[min(480px,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle>{t("agents.reset.title")}</DialogTitle>
            <DialogDescription>{t("agents.reset.description")}</DialogDescription>
          </DialogHeader>
          <div className="button-row">
            <Button variant="destructive" disabled={busy} onClick={() => void resetToken()}>
              {t("agents.reset.confirm")}
            </Button>
            <Button variant="outline" onClick={() => setConfirmReset(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
        <DialogContent className="max-w-[min(480px,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle>{t("agents.revoke.title")}</DialogTitle>
            <DialogDescription>{t("agents.revoke.description")}</DialogDescription>
          </DialogHeader>
          <div className="button-row">
            <Button variant="destructive" disabled={busy} onClick={() => void revoke()}>
              {t("access.revoke")}
            </Button>
            <Button variant="outline" onClick={() => setConfirmRevoke(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
