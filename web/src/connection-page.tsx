import type { AuthDefinition, AppData, ConnectionRecord, ProviderDefinition, RunLog } from "./model";
import type { ReactNode } from "react";

import { useTranslate } from "@embra/i18n/react";
import { ArrowLeft, Bot, CircleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import {
  agentConnectionActionNames,
  buildConnectionAccess,
  runtimeRulesAllowingAction,
  runtimeRulesBlockingAction,
  tokensCoveringConnection,
} from "./agent-access";
import { apiPut } from "./api";
import { EmptyRows, Row, RowList } from "./components/row-list";
import { emptyData, formatDate } from "./model";
import { OAuthAppDialog } from "./oauth-app-form";
import { authTypeLabel, ConnectionForm, connectionDisplayLabel, initialAuthType } from "./providers-page";
import { Badge, EmptyState, ProviderIcon, providerInitials, StatusDot } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

const recentRunLimit = 10;

interface ConnectionPageProps {
  data: AppData;
  onRefresh(): void;
}

export function ConnectionPage(props: ConnectionPageProps): ReactNode {
  const t = useTranslate();
  const params = useParams();
  const connection = props.data.connections.find((entry) => entry.id === params.connectionId);

  if (!connection) {
    return (
      <section className="detail-panel">
        <EmptyState
          icon={<CircleAlert size={20} />}
          title={t("connections.missing.title")}
          description={t("connections.missing.description")}
        />
      </section>
    );
  }
  return <ConnectionDetail connection={connection} data={props.data} onRefresh={props.onRefresh} />;
}

function ConnectionDetail(props: { connection: ConnectionRecord; data: AppData; onRefresh(): void }): ReactNode {
  const t = useTranslate();
  const connection = props.connection;
  const policy = props.data.runtimePolicy ?? emptyData.runtimePolicy!;
  const provider = props.data.providers.find((entry) => entry.service === connection.service);
  const auth = provider ? authForConnection(provider, connection) : undefined;
  const oauthAuth = provider?.auth.find((entry) => entry.type === "oauth2");
  const oauthConfig = props.data.oauthConfigs.find((config) => config.service === connection.service);
  const [oauthClientMode, setOAuthClientMode] = useState<"configured" | "manual">("configured");
  const [oauthAppDialogOpen, setOAuthAppDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const accessRows = useMemo(
    () =>
      provider
        ? buildConnectionAccess({
            connection,
            provider,
            policy,
            tokens: props.data.runtimeTokens,
          })
        : [],
    [provider, connection, policy, props.data.runtimeTokens],
  );
  const agents = useMemo(
    () => tokensCoveringConnection(connection, props.data.runtimeTokens),
    [connection, props.data.runtimeTokens],
  );
  const recentRuns = useMemo(
    () => props.data.runs.filter((run) => runTouchesConnection(run, connection)).slice(0, recentRunLimit),
    [props.data.runs, connection],
  );

  async function toggleDefault(action: { id: string }, allowed: boolean): Promise<void> {
    setSaving(true);
    try {
      await apiPut(
        "/api/runtime-policy",
        allowed
          ? runtimeRulesAllowingAction(policy.runtime, action.id, props.data.providers)
          : runtimeRulesBlockingAction(policy.runtime, action.id, props.data.providers),
      );
      props.onRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("connections.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="detail-panel access-panel">
      <div className="provider-detail-title-row">
        <Button asChild variant="outline" size="icon-sm">
          <Link to="/connections" aria-label={t("connections.back")} title={t("connections.back")}>
            <ArrowLeft size={15} />
          </Link>
        </Button>
        {provider ? (
          <ProviderIcon provider={provider} large />
        ) : (
          <span className="provider-icon large">{providerInitials(connection.service)}</span>
        )}
        <div className="provider-detail-heading-copy">
          <div className="provider-detail-heading-title">
            <h2>{provider?.displayName ?? connection.service}</h2>
            <Badge>{authTypeLabel(connection.authType, t)}</Badge>
            {connection.pact?.needsReauthorization ? (
              <Badge tone="warning">{t("connections.pact.needsReauthorization")}</Badge>
            ) : null}
          </div>
          <div className="provider-detail-meta">
            <span>{connectionDisplayLabel(connection)}</span>
            <span className="provider-service-id">{connection.service}</span>
          </div>
        </div>
      </div>

      <section className="agent-access">
        <div className="agent-section-heading">
          <h3 className="agent-section-title">{t("connections.permissions.title")}</h3>
        </div>
        <p className="connection-section-copy">{t("connections.permissions.description")}</p>
        {accessRows.length === 0 ? (
          <p className="agent-access-empty">{t("connections.permissions.empty")}</p>
        ) : (
          <ul className="agent-fold-actions">
            {accessRows.map((row) => (
              <li className="agent-action-row" key={row.action.id}>
                <Checkbox
                  checked={row.defaultAllowed}
                  disabled={saving || row.deploymentBlocked}
                  onCheckedChange={(checked) => void toggleDefault(row.action, checked === true)}
                  aria-label={row.action.name}
                />
                <div className="agent-action-copy">
                  <div className="agent-action-title">
                    <span>{row.action.name}</span>
                    {row.highRisk ? <Badge>{t("agents.access.highRisk")}</Badge> : null}
                  </div>
                  <small>
                    {row.action.description}
                    {row.deploymentBlocked ? ` · ${t("agents.access.blockedByPolicy")}` : ""}
                  </small>
                </div>
                {row.changedAgents > 0 ? (
                  <span className="connection-changed-agents">
                    {t("agents.access.defaultChanged", { count: row.changedAgents })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="agent-activity">
        <div className="agent-section-heading">
          <h3 className="agent-section-title">{t("connections.agents.title")}</h3>
        </div>
        <RowList>
          {agents.length === 0 ? (
            <EmptyRows>{t("connections.agents.empty")}</EmptyRows>
          ) : (
            agents.map((token) => {
              const actions = provider ? agentConnectionActionNames(token, provider, policy) : [];
              return (
                <Row
                  key={token.id}
                  to={`/agents/${token.id}`}
                  icon={<Bot size={16} />}
                  title={token.name}
                  cells={
                    <span className="connections-cell-actions">
                      {actions.length > 0 ? actions.join(", ") : t("connections.agents.noActions")}
                    </span>
                  }
                />
              );
            })
          )}
        </RowList>
      </section>

      <section className="agent-activity">
        <div className="agent-section-heading">
          <h3 className="agent-section-title">{t("connections.activity.title")}</h3>
          <Link to={`/activity?connection=${encodeURIComponent(connection.id!)}`}>
            {t("connections.activity.viewAll")}
          </Link>
        </div>
        <RowList>
          {recentRuns.length === 0 ? (
            <EmptyRows>{t("connections.activity.empty")}</EmptyRows>
          ) : (
            recentRuns.map((run) => (
              <Row
                key={run.id}
                icon={<StatusDot ok={run.ok} />}
                title={run.actionId}
                cells={
                  <>
                    <span className="agents-cell-conn hidden md:block">
                      {run.runtimeTokenId
                        ? (props.data.runtimeTokens.find((token) => token.id === run.runtimeTokenId)?.name ??
                          run.runtimeTokenId)
                        : run.caller}
                    </span>
                    <span className="agents-cell-time">{formatDate(run.startedAt)}</span>
                  </>
                }
              />
            ))
          )}
        </RowList>
      </section>

      {provider && auth ? (
        <section className="agent-access">
          <div className="agent-section-heading">
            <h3 className="agent-section-title">{t("connections.credentials.title")}</h3>
          </div>
          <ConnectionForm
            provider={provider}
            auth={auth}
            connection={connection}
            connectionName={connection.connectionName?.trim() || "default"}
            connectionNameValid
            oauthConfig={oauthConfig}
            oauthClientMode={oauthClientMode}
            onRefresh={props.onRefresh}
            onConfigureOAuthClient={() => setOAuthAppDialogOpen(true)}
            onOAuthClientModeChange={setOAuthClientMode}
          />
        </section>
      ) : null}

      {connection.pact ? (
        <section className="agent-activity">
          <div className="agent-section-heading">
            <h3 className="agent-section-title">{t("connections.pact.title")}</h3>
          </div>
          <dl className="connection-meta">
            {connection.pact.brandDomain ? (
              <>
                <dt>{t("connections.pact.brand")}</dt>
                <dd>{connection.pact.brandDomain}</dd>
              </>
            ) : null}
            <dt>{t("connections.pact.card")}</dt>
            <dd>
              <a href={connection.pact.cardUrl} target="_blank" rel="noreferrer">
                {connection.pact.cardUrl}
              </a>
            </dd>
            <dt>{t("connections.pact.interface")}</dt>
            <dd>{connection.pact.interfaceUrl}</dd>
            <dt>{t("connections.pact.providerOrigin")}</dt>
            <dd>{connection.pact.providerOrigin}</dd>
            <dt>{t("connections.pact.registration")}</dt>
            <dd>{connection.pact.registrationId}</dd>
            {connection.identityOnly ? (
              <>
                <dt />
                <dd>
                  <Badge>{t("connections.pact.identityOnly")}</Badge>
                </dd>
              </>
            ) : null}
          </dl>
        </section>
      ) : null}

      {oauthAuth && provider ? (
        <OAuthAppDialog
          open={oauthAppDialogOpen}
          provider={provider}
          auth={oauthAuth}
          config={oauthConfig}
          onOpenChange={setOAuthAppDialogOpen}
          onRefresh={props.onRefresh}
        />
      ) : null}
    </section>
  );
}

function authForConnection(provider: ProviderDefinition, connection: ConnectionRecord): AuthDefinition | undefined {
  const type = initialAuthType(provider, connection);
  return provider.auth.find((auth) => auth.type === type);
}

function runTouchesConnection(run: RunLog, connection: ConnectionRecord): boolean {
  if (run.connectionId != null) {
    return run.connectionId === connection.id;
  }
  return run.service === connection.service;
}
