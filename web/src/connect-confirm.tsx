import type { ActionDefinition, AppData, ConnectionRecord, ProviderDefinition } from "./model";
import type { ReactNode } from "react";

import { useTranslate } from "@embra/i18n/react";
import { Check, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { buildConnectionAccess, runtimeRulesAllowingAction, runtimeRulesBlockingAction } from "./agent-access";
import { apiPut } from "./api";
import { DefaultPermissionList } from "./components/default-permissions";
import { emptyData } from "./model";
import { Button } from "@/components/ui/button";

interface ConnectPermissionsConfirmProps {
  connection: ConnectionRecord;
  provider: ProviderDefinition;
  data: AppData;
  onRefresh(): void;
  /** Finished reviewing — the caller lands the user on the new connection. */
  onDone(): void;
  /** Stay in the connect flow for another connection of the same provider. */
  onConnectAnother(): void;
}

// PAP's per-connection permission confirm: after credentials are collected,
// the service's action list as the default-policy checkboxes before the flow
// finishes. Toggles write the runtime default layer immediately, so Done only
// needs to leave the page.
export function ConnectPermissionsConfirm(props: ConnectPermissionsConfirmProps): ReactNode {
  const t = useTranslate();
  const policy = props.data.runtimePolicy ?? emptyData.runtimePolicy!;
  const [saving, setSaving] = useState(false);
  const rows = useMemo(
    () =>
      buildConnectionAccess({
        connection: props.connection,
        provider: props.provider,
        policy,
        tokens: props.data.runtimeTokens,
      }),
    [props.connection, props.provider, policy, props.data.runtimeTokens],
  );

  async function toggle(action: ActionDefinition, allowed: boolean): Promise<void> {
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
    <div className="connect-confirm">
      <h3 className="agent-section-title">{t("connections.confirm.title")}</h3>
      <p className="connection-section-copy">
        {t("connections.confirm.description", { name: props.provider.displayName })}
      </p>
      {rows.length === 0 ? (
        <p className="agent-access-empty">{t("connections.permissions.empty")}</p>
      ) : (
        <DefaultPermissionList
          rows={rows}
          disabled={saving}
          onToggle={(action, allowed) => void toggle(action, allowed)}
        />
      )}
      <div className="button-row">
        <Button type="button" onClick={props.onDone}>
          <Check size={16} />
          {t("connections.confirm.finish")}
        </Button>
        <Button variant="outline" type="button" onClick={props.onConnectAnother}>
          <Plus size={16} />
          {t("connections.confirm.connectAnother")}
        </Button>
        <Button asChild variant="ghost" type="button">
          <Link to="/agents">{t("connections.added.setAccess")}</Link>
        </Button>
      </div>
    </div>
  );
}
