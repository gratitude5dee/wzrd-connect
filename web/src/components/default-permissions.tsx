import type { ConnectionAccessRow } from "../agent-access";
import type { ActionDefinition } from "../model";
import type { ReactNode } from "react";

import { useTranslate } from "@embra/i18n/react";
import { Badge } from "../shared-ui";
import { Checkbox } from "@/components/ui/checkbox";

interface DefaultPermissionListProps {
  rows: ConnectionAccessRow[];
  /** Disables every checkbox, e.g. while a save is in flight. */
  disabled?: boolean;
  onToggle(action: ActionDefinition, allowed: boolean): void;
}

// The "default policy" checkbox list: one row per catalog action with its
// description, a High risk badge where approval-gated, and the count of
// agents whose own setting diverges. Shared by the connection detail's
// Permissions section and the post-connect confirm step.
export function DefaultPermissionList(props: DefaultPermissionListProps): ReactNode {
  const t = useTranslate();
  return (
    <ul className="agent-fold-actions">
      {props.rows.map((row) => (
        <li className="agent-action-row" key={row.action.id}>
          <Checkbox
            checked={row.defaultAllowed}
            disabled={props.disabled || row.deploymentBlocked}
            onCheckedChange={(checked) => props.onToggle(row.action, checked === true)}
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
  );
}
