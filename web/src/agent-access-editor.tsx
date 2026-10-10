import type { AgentAccessPatch } from "./agent-access";
import type {
  ActionDefinition,
  ConnectionRecord,
  ProviderDefinition,
  RuntimePolicyState,
  RuntimeTokenSummary,
} from "./model";
import type { ReactNode } from "react";

import { useTranslate } from "@embra/i18n/react";
import { CheckCheck, ChevronRight, Search, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { createConnectionGrantDraft, runtimeTokenPolicyBody } from "./access-editors";
import {
  buildAgentAccess,
  resetAgentAction,
  runtimeRulesBlockingAction,
  setAgentActionAllowed,
  tokenPolicyRules,
} from "./agent-access";
import { apiPut } from "./api";
import { matchesActionRule } from "./policy";
import { Badge, ProviderIcon } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface AgentAccessEditorProps {
  token: RuntimeTokenSummary;
  tokens: RuntimeTokenSummary[];
  policy: RuntimePolicyState;
  providers: ProviderDefinition[];
  connections: ConnectionRecord[];
  onRefresh(): void;
}

export function AgentAccessEditor(props: AgentAccessEditorProps): ReactNode {
  const t = useTranslate();
  const [query, setQuery] = useState("");
  const [changedOnly, setChangedOnly] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Optimistic copy of the token's rules while writes are in flight. */
  const [draft, setDraft] = useState<AgentAccessPatch | null>(null);
  const writesRef = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const basePatch = useMemo<AgentAccessPatch>(
    () => ({ rules: tokenPolicyRules(props.token), allowedConnections: [...props.token.allowedConnections] }),
    [props.token],
  );

  useEffect(() => {
    // Server state caught up with the persisted writes — drop the optimistic copy.
    if (writesRef.current === 0) {
      setDraft(null);
    }
  }, [props.token]);

  const patch = draft ?? basePatch;
  const model = useMemo(
    () =>
      buildAgentAccess({
        token: props.token,
        rules: patch.rules,
        allowedConnections: patch.allowedConnections,
        policy: props.policy,
        providers: props.providers,
        connections: props.connections,
      }),
    [props.token, patch, props.policy, props.providers, props.connections],
  );

  const filtering = query.trim().length > 0 || changedOnly;
  const normalizedQuery = query.trim().toLowerCase();

  function matchesFilter(row: { action: ActionDefinition; overridden: boolean }): boolean {
    if (changedOnly && !row.overridden) {
      return false;
    }
    if (!normalizedQuery) {
      return true;
    }
    const action = row.action;
    return (
      action.id.toLowerCase().includes(normalizedQuery) ||
      action.name.toLowerCase().includes(normalizedQuery) ||
      action.description.toLowerCase().includes(normalizedQuery)
    );
  }

  function persist(next: AgentAccessPatch): void {
    writesRef.current += 1;
    setDraft(next);
    queueRef.current = queueRef.current
      .then(async () => {
        try {
          await apiPut(
            `/api/runtime-tokens/${props.token.id}`,
            runtimeTokenPolicyBody(next.rules, createConnectionGrantDraft(next.allowedConnections)),
          );
        } catch (error) {
          writesRef.current = Math.max(0, writesRef.current - 1);
          setDraft(null);
          toast.error(error instanceof Error ? error.message : t("agents.access.saveFailed"));
          props.onRefresh();
          throw error;
        }
      })
      .then(() => {
        writesRef.current = Math.max(0, writesRef.current - 1);
        props.onRefresh();
      })
      .catch(() => undefined);
  }

  function reset(row: { action: ActionDefinition }): void {
    persist(resetAgentAction({ patch, action: row.action, providers: props.providers }));
  }

  async function makeDefault(row: { action: ActionDefinition }): Promise<void> {
    const action = row.action;
    const affected = props.tokens.filter((token) => {
      if (token.id === props.token.id || token.blockedActions.some((rule) => matchesActionRule(rule, action.id))) {
        return false;
      }
      return (
        token.allowedActions.length === 0 || token.allowedActions.some((rule) => matchesActionRule(rule, action.id))
      );
    });
    try {
      await apiPut("/api/runtime-policy", runtimeRulesBlockingAction(props.policy.runtime, action.id, props.providers));
      persist(resetAgentAction({ patch, action, providers: props.providers }));
      toast.success(t("agents.access.defaultChanged", { count: affected.length }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("agents.access.saveFailed"));
    }
  }

  function toggleFold(id: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const visibleFolds = model.folds
    .map((fold) => ({ ...fold, rows: fold.rows.filter(matchesFilter) }))
    .filter((fold) => !filtering || fold.rows.length > 0);

  return (
    <div className="agent-access-editor">
      <div className="agent-access-toolbar">
        <div className="agent-access-search">
          <Search size={15} />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("agents.access.filterPlaceholder")}
            aria-label={t("agents.access.filterPlaceholder")}
          />
        </div>
        <label className="agent-access-changed-only">
          <Checkbox
            checked={changedOnly}
            onCheckedChange={(checked) => setChangedOnly(checked === true)}
            aria-label={t("agents.access.changedOnly")}
          />
          <span>{t("agents.access.changedOnly")}</span>
        </label>
      </div>

      {visibleFolds.length === 0 ? (
        <p className="agent-access-empty">
          {t(model.folds.length === 0 ? "agents.access.noConnections" : "agents.access.noMatches")}
        </p>
      ) : (
        <ul className="agent-access-folds">
          {visibleFolds.map((fold) => {
            const open = filtering || expanded.has(fold.connectionId);
            return (
              <li className="agent-access-fold" key={fold.connectionId}>
                <button
                  type="button"
                  className="agent-fold-header"
                  aria-expanded={open}
                  onClick={() => toggleFold(fold.connectionId)}
                >
                  <ChevronRight className="agent-fold-chevron" data-open={open ? true : undefined} size={16} />
                  {fold.provider ? <ProviderIcon provider={fold.provider} /> : null}
                  <span className="agent-fold-title">
                    <strong>{fold.connectionName}</strong>
                    <small>{fold.provider?.displayName ?? fold.service}</small>
                  </span>
                  <Badge tone={fold.changed > 0 ? "warning" : undefined}>
                    {fold.changed > 0
                      ? t("agents.access.changed", { count: fold.changed })
                      : t("agents.access.default")}
                  </Badge>
                </button>
                {open ? (
                  <ul className="agent-fold-actions">
                    {fold.rows.map((row) => (
                      <AccessActionRow
                        key={row.action.id}
                        row={row}
                        onToggle={() =>
                          persist(
                            setAgentActionAllowed({
                              patch,
                              action: row.action,
                              connectionId: fold.connectionId,
                              allowed: !row.effectiveAllowed,
                              providers: props.providers,
                            }),
                          )
                        }
                        onMakeDefault={() => void makeDefault(row)}
                        onReset={() => reset(row)}
                      />
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AccessActionRow(props: {
  row: {
    action: ActionDefinition;
    defaultAllowed: boolean;
    effectiveAllowed: boolean;
    overridden: boolean;
    highRisk: boolean;
  };
  onToggle(): void;
  onMakeDefault(): void;
  onReset(): void;
}): ReactNode {
  const t = useTranslate();
  const row = props.row;
  const disabled = !row.defaultAllowed;
  return (
    <li className={row.overridden ? "agent-action-row overridden" : "agent-action-row"}>
      <Checkbox
        checked={row.effectiveAllowed}
        disabled={disabled}
        onCheckedChange={() => props.onToggle()}
        aria-label={row.action.name}
      />
      <div className="agent-action-copy">
        <div className="agent-action-title">
          <span>{row.action.name}</span>
          {row.highRisk ? <Badge>{t("agents.access.highRisk")}</Badge> : null}
        </div>
        <small>
          {row.action.description}
          {disabled ? ` · ${t("agents.access.blockedByPolicy")}` : ""}
        </small>
      </div>
      {row.overridden ? (
        <span className="agent-action-tools">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("agents.access.makeDefault")}
                onClick={props.onMakeDefault}
              >
                <CheckCheck size={15} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("agents.access.makeDefault")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("agents.access.reset")} onClick={props.onReset}>
                <Undo2 size={15} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("agents.access.reset")}</TooltipContent>
          </Tooltip>
        </span>
      ) : null}
    </li>
  );
}
