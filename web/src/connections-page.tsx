import type { AppData, ConnectionRecord, ProviderDefinition } from "./model";
import type { ReactNode } from "react";

import { useTranslate } from "@embra/i18n/react";
import { CheckCircle2, Plus } from "lucide-react";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { tokensCoveringConnection } from "./agent-access";
import { EmptyRows, Row, RowHeader, RowList } from "./components/row-list";
import { isUsableCredentialConnection } from "./model";
import { connectionDisplayLabel } from "./providers-page";
import { ProviderIcon, providerInitials } from "./shared-ui";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface ConnectionsPageProps {
  data: AppData;
  onRefresh(): void;
}

export function ConnectionsPage(props: ConnectionsPageProps): ReactNode {
  const t = useTranslate();
  const [searchParams] = useSearchParams();
  const addedId = searchParams.get("added") ?? undefined;
  const providers = useMemo(
    () => new Map(props.data.providers.map((provider) => [provider.service, provider])),
    [props.data.providers],
  );
  const connections = useMemo(
    () =>
      props.data.connections
        .filter((connection) => connection.id != null && isUsableCredentialConnection(connection))
        .sort(compareConnections(providers)),
    [props.data.connections, providers],
  );

  return (
    <section className="detail-panel access-panel">
      <div className="access-section-heading">
        <div>
          <h2>{t("connections.title")}</h2>
          <p>{t("connections.description")}</p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/providers">
            <Plus size={15} />
            {t("connections.connect")}
          </Link>
        </Button>
      </div>
      {addedId ? (
        <Alert variant="success">
          <CheckCircle2 size={16} />
          <AlertDescription>
            {t("connections.added.success")}{" "}
            <Link className="connection-added-link" to="/agents">
              {t("connections.added.setAccess")}
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}
      <RowList
        header={
          <RowHeader>
            <span className="w-4" />
            <span className="min-w-0 flex-1 truncate">{t("connections.columns.service")}</span>
            <span className="connections-cell-account hidden md:block">{t("connections.columns.account")}</span>
            <span className="connections-cell-agents">{t("connections.columns.agents")}</span>
          </RowHeader>
        }
      >
        {connections.length === 0 ? (
          <EmptyRows
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="/providers">{t("connections.browseProviders")}</Link>
              </Button>
            }
          >
            {t("connections.empty.title")}
          </EmptyRows>
        ) : (
          connections.map((connection) => {
            const provider = providers.get(connection.service);
            return (
              <Row
                key={connection.id}
                to={`/connections/${connection.id}`}
                highlighted={connection.id === addedId}
                icon={<ConnectionIcon provider={provider} service={connection.service} />}
                title={provider?.displayName ?? connection.service}
                cells={
                  <>
                    <span className="connections-cell-account hidden md:block">
                      {connectionDisplayLabel(connection)}
                    </span>
                    <span className="connections-cell-agents">
                      {tokensCoveringConnection(connection, props.data.runtimeTokens).length}
                    </span>
                  </>
                }
              />
            );
          })
        )}
        {connections.length > 0 ? (
          <Row
            to="/providers"
            icon={<Plus className="text-muted-foreground" size={15} />}
            title={t("connections.connectAnother")}
          />
        ) : null}
      </RowList>
    </section>
  );
}

function ConnectionIcon(props: { provider?: ProviderDefinition; service: string }): ReactNode {
  if (props.provider) {
    return <ProviderIcon provider={props.provider} />;
  }
  return <span className="provider-icon">{providerInitials(props.service)}</span>;
}

function compareConnections(
  providers: ReadonlyMap<string, ProviderDefinition>,
): (left: ConnectionRecord, right: ConnectionRecord) => number {
  return (left, right) => {
    const leftName = providers.get(left.service)?.displayName ?? left.service;
    const rightName = providers.get(right.service)?.displayName ?? right.service;
    return leftName.localeCompare(rightName) || (left.connectionName ?? "").localeCompare(right.connectionName ?? "");
  };
}
