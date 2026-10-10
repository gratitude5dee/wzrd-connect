import type {
  ApprovalListPage,
  ApprovalRecord,
  ConnectionRecord,
  RunLog,
  RunLogPage,
  RuntimeTokenSummary,
} from "./model";
import type { ReactNode, SubmitEvent } from "react";

import { useTranslate } from "@embra/i18n/react";
import { ChevronDown, ChevronUp, Loader2, Search, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { apiGet } from "./api";
import { CopyButton } from "./components/copy-field";
import { EmptyRows, Row, RowHeader, RowList } from "./components/row-list";
import { formatDateTime } from "./model";
import { Badge, InlineError } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TooltipProvider } from "@/components/ui/tooltip";

export type ActivityStatus = "ok" | "pending" | "denied" | "failed";
export type ActivityKind = "run" | "approval";

export interface ActivityFilters {
  // Runtime token id, or the "admin" sentinel for requests without a token.
  agent: string | null;
  // Connection id, connection name, or provider service — all three match.
  connection: string | null;
  status: ActivityStatus | null;
  // Approval id deep link: shows the approval plus the runs gated by it.
  approval: string | null;
  // Restricts the feed to one event kind; /runs presets "run".
  kind: ActivityKind | null;
  // Legacy /runs query params, kept working on old deep links.
  actionId: string;
  caller: RunLog["caller"] | null;
  // Legacy `ok=false` links meant "every failed run"; `ok=true` folds into status.
  errorsOnly: boolean;
}

export interface ActivityPageProps {
  initialRuns: RunLog[];
  runsNextCursor?: string;
  connections: ConnectionRecord[];
  runtimeTokens: RuntimeTokenSummary[];
  // /runs renders the same feed restricted to run events.
  preset?: ActivityKind;
  // Tests render the expanded detail row through this instead of a click.
  initialExpanded?: readonly string[];
}

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  at: string;
  run?: RunLog;
  approval?: ApprovalRecord;
}

const allAgentsFilterValue = "__all_agents__";
const allConnectionsFilterValue = "__all_connections__";
const allStatusesFilterValue = "__all_statuses__";
const adminAgentFilterValue = "__admin__";
const activityPageLimit = 50;

// RunLog error codes that mean "refused by policy or auth" rather than "the
// action ran and errored" — they render as denied rows like PAP's red lines.
// The auth-layer set ("unauthorized"/"forbidden") is written by
// ActionRunner.recordDeniedRequest for rejections before the runner.
const deniedErrorCodes = new Set([
  "action_not_allowed",
  "action_blocked",
  "connection_not_allowed",
  "proxy_not_allowed",
  "proxy_blocked",
  "trigger_not_allowed",
  "trigger_blocked",
  "forbidden",
  "unauthorized",
  "policy_denied",
  "denied",
]);

// The column schema the header and every row share: Time / Agent / Request /
// Connection / Result, plus the run-detail toggle on run rows. Hidden cells
// fold away on narrow widths from the least useful column inward.
const ACTIVITY_CELLS = {
  time: "w-28 shrink-0 text-muted-foreground tabular-nums",
  agent: "hidden w-36 shrink-0 truncate text-muted-foreground md:block",
  connection: "hidden w-40 shrink-0 truncate text-right text-muted-foreground md:block",
  result: "w-20 shrink-0 text-right",
  toggle: "flex w-6 shrink-0 items-center justify-end text-muted-foreground",
};

export function ActivityPage(props: ActivityPageProps): ReactNode {
  const t = useTranslate();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = activityFiltersFromSearchParams(searchParams, props.preset);
  const [runs, setRuns] = useState(props.initialRuns);
  const [runsCursor, setRunsCursor] = useState(props.runsNextCursor);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [approvalsCursor, setApprovalsCursor] = useState<string | undefined>(undefined);
  const [approvalsUnavailable, setApprovalsUnavailable] = useState(false);
  const [actionDraft, setActionDraft] = useState(filters.actionId);
  const [loading, setLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [expandedResults, setExpandedResults] = useState<Set<string>>(() => new Set(props.initialExpanded));
  const requestGeneration = useRef(0);
  // The service the run list's `service` param can narrow on: the resolved
  // configured connection's service, or the raw value when it names one.
  const connectionService =
    filters.connection === null
      ? undefined
      : (findConfiguredConnection(filters.connection, props.connections)?.service ?? filters.connection);
  // The select displays the canonical option value (the connection id when the
  // filter resolved to a configured connection) instead of a blank trigger.
  const connectionSelectValue =
    filters.connection === null
      ? allConnectionsFilterValue
      : (findConfiguredConnection(filters.connection, props.connections)?.id ?? filters.connection);
  // A kind value from the preset (/runs) is not a filter the user set.
  const hasFilters = Boolean(
    filters.agent ||
    filters.connection ||
    filters.status ||
    filters.approval ||
    (filters.kind !== null && filters.kind !== props.preset) ||
    filters.actionId ||
    filters.caller ||
    filters.errorsOnly,
  );

  // Any filter invalidates the initial unfiltered window: the merged feed is
  // rebuilt from both endpoints with the server-side subset applied.
  useEffect(() => {
    const generation = ++requestGeneration.current;
    setActionDraft(filters.actionId);
    setActivityError(null);
    if (!hasFilters) {
      setRuns(props.initialRuns);
      setRunsCursor(props.runsNextCursor);
      setLoading(false);
      if (filters.kind !== "run") void loadApprovals(undefined, generation);
      return;
    }
    void loadFiltered(generation, filters);
  }, [props.initialRuns, props.runsNextCursor, searchParams, props.preset]);

  // An `?approval=<id>` deep link needs the record even when it sits outside
  // the paged window, so it is fetched straight by id.
  useEffect(() => {
    if (!filters.approval || approvals.some((record) => record.id === filters.approval)) return;
    let cancelled = false;
    apiGet<ApprovalRecord>(`/api/approvals/${encodeURIComponent(filters.approval)}`)
      .then((record) => {
        if (!cancelled) setApprovals((current) => mergeApprovals(current, [record]));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [filters.approval, approvals]);

  async function loadFiltered(generation: number, nextFilters: ActivityFilters): Promise<void> {
    setLoading(true);
    setRuns([]);
    setRunsCursor(undefined);
    setApprovals([]);
    setApprovalsCursor(undefined);
    const wantApprovals = nextFilters.kind !== "run";
    const wantRuns = nextFilters.kind !== "approval";
    try {
      const [runPage, approvalPage] = await Promise.all([
        wantRuns
          ? apiGet<RunLogPage>(activityRunsPath({ filters: nextFilters, connectionService }))
          : Promise.resolve<RunLogPage>({ items: [] }),
        wantApprovals
          ? apiGet<ApprovalListPage>(activityApprovalsPath({ filters: nextFilters }))
          : Promise.resolve<null>(null),
      ]);
      if (generation !== requestGeneration.current) return;
      setRuns(runPage.items);
      setRunsCursor(runPage.nextCursor);
      if (approvalPage !== null) {
        setApprovals(approvalPage.items);
        setApprovalsCursor(approvalPage.nextCursor);
      }
    } catch (caught) {
      if (generation !== requestGeneration.current) return;
      setActivityError(caught instanceof Error ? caught.message : t("activity.loadFailed"));
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }

  async function loadApprovals(cursor: string | undefined, generation: number): Promise<void> {
    try {
      const page = await apiGet<ApprovalListPage>(activityApprovalsPath({ cursor, filters }));
      if (generation !== requestGeneration.current) return;
      setApprovals((current) => mergeApprovals(current, page.items));
      setApprovalsCursor(page.nextCursor);
    } catch {
      if (generation !== requestGeneration.current) return;
      // Older runtimes may not serve the approvals API; the feed still works.
      setApprovalsUnavailable(true);
    }
  }

  async function loadMore(): Promise<void> {
    if ((!runsCursor && !approvalsCursor) || loading) return;
    const generation = ++requestGeneration.current;
    setLoading(true);
    setActivityError(null);
    try {
      const [runPage, approvalPage] = await Promise.all([
        runsCursor
          ? apiGet<RunLogPage>(activityRunsPath({ cursor: runsCursor, filters, connectionService }))
          : Promise.resolve<RunLogPage>({ items: [] }),
        approvalsCursor
          ? apiGet<ApprovalListPage>(activityApprovalsPath({ cursor: approvalsCursor, filters }))
          : Promise.resolve<null>(null),
      ]);
      if (generation !== requestGeneration.current) return;
      setRuns((current) => [...current, ...runPage.items]);
      setRunsCursor(runPage.nextCursor);
      if (approvalPage) {
        setApprovals((current) => mergeApprovals(current, approvalPage.items));
        setApprovalsCursor(approvalPage.nextCursor);
      }
    } catch (caught) {
      if (generation !== requestGeneration.current) return;
      setActivityError(caught instanceof Error ? caught.message : t("activity.loadFailed"));
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }

  function updateFilter(name: string, value: string | null): void {
    requestGeneration.current += 1;
    setLoading(false);
    const next = new URLSearchParams(searchParams);
    if (value === null || value === "") next.delete(name);
    else next.set(name, value);
    // The visible selects own their canonical params; touching them retires the
    // legacy /runs spellings they replace.
    if (name === "connection") next.delete("service");
    if (name === "status") next.delete("ok");
    setSearchParams(next, { replace: true });
  }

  function submitActionFilter(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    updateFilter("actionId", actionDraft.trim());
  }

  function toggleResult(id: string): void {
    setExpandedResults((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const events = activityEvents(
    filters.kind === "approval" ? [] : runs,
    filters.kind === "run" ? [] : approvals,
  ).filter((event) => activityEventMatches(event, filters, props.connections));
  const tokenLabels = new Map(props.runtimeTokens.map((token) => [token.id, token.name || token.id]));
  const agentOptions = agentFilterOptions(props.runtimeTokens, runs, approvals, t);
  const connectionOptions = connectionFilterOptions(props.connections, runs, approvals);
  const canLoadMore = Boolean(runsCursor || (approvalsCursor && filters.kind !== "run"));

  return (
    <TooltipProvider>
      <div className="page-stack runs-page activity-page">
        <section className="page-toolbar runs-toolbar">
          <form className="run-action-filter" onSubmit={submitActionFilter}>
            <Input
              value={actionDraft}
              onChange={(event) => setActionDraft(event.target.value)}
              placeholder={t("activity.actionPlaceholder")}
              aria-label={t("activity.action")}
            />
            <Button type="submit" variant="outline" size="icon-sm" aria-label={t("activity.applyActionFilter")}>
              <Search size={14} />
            </Button>
          </form>
          <ActivitySelect
            label={t("activity.agent")}
            value={filters.agent ?? allAgentsFilterValue}
            onChange={(value) => updateFilter("agent", value === allAgentsFilterValue ? null : value)}
          >
            <SelectItem value={allAgentsFilterValue}>{t("activity.allAgents")}</SelectItem>
            {agentOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </ActivitySelect>
          <ActivitySelect
            label={t("activity.connection")}
            value={connectionSelectValue}
            onChange={(value) => updateFilter("connection", value === allConnectionsFilterValue ? null : value)}
          >
            <SelectItem value={allConnectionsFilterValue}>{t("activity.allConnections")}</SelectItem>
            {connectionOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </ActivitySelect>
          <ActivitySelect
            label={t("activity.status")}
            value={filters.status ?? allStatusesFilterValue}
            onChange={(value) => updateFilter("status", value === allStatusesFilterValue ? null : value)}
          >
            <SelectItem value={allStatusesFilterValue}>{t("activity.allStatuses")}</SelectItem>
            <SelectItem value="ok">{t("activity.statuses.ok")}</SelectItem>
            <SelectItem value="pending">{t("activity.statuses.pending")}</SelectItem>
            <SelectItem value="denied">{t("activity.statuses.denied")}</SelectItem>
            <SelectItem value="failed">{t("activity.statuses.failed")}</SelectItem>
          </ActivitySelect>
          {filters.approval ? (
            <Button
              variant="outline"
              size="sm"
              className="activity-approval-chip"
              onClick={() => updateFilter("approval", null)}
            >
              {t("activity.approvalFilter", { id: filters.approval })}
              <X size={13} />
            </Button>
          ) : null}
        </section>

        <RowList
          header={
            <RowHeader>
              <span className={ACTIVITY_CELLS.time}>{t("activity.columns.time")}</span>
              <span className={ACTIVITY_CELLS.agent}>{t("activity.columns.agent")}</span>
              <span className="min-w-0 flex-1 truncate">{t("activity.columns.request")}</span>
              <span className={ACTIVITY_CELLS.connection}>{t("activity.columns.connection")}</span>
              <span className={ACTIVITY_CELLS.result}>{t("activity.columns.result")}</span>
              <span className={ACTIVITY_CELLS.toggle} />
            </RowHeader>
          }
        >
          {events.length === 0 ? (
            <EmptyRows>
              {hasFilters ? t("activity.emptyFiltered") : t("activity.empty")}
              {approvalsUnavailable ? ` ${t("activity.approvalsUnavailable")}` : ""}
            </EmptyRows>
          ) : (
            events.map((event) => {
              if (event.kind === "approval" && event.approval) {
                return (
                  <ApprovalRow
                    key={event.id}
                    approval={event.approval}
                    agentLabel={
                      event.approval.runtimeTokenId
                        ? (tokenLabels.get(event.approval.runtimeTokenId) ?? event.approval.runtimeTokenId)
                        : t("activity.admin")
                    }
                    t={t}
                  />
                );
              }
              if (!event.run) return null;
              return (
                <Fragment key={event.id}>
                  <RunRow
                    run={event.run}
                    agentLabel={
                      event.run.runtimeTokenId
                        ? (tokenLabels.get(event.run.runtimeTokenId) ?? event.run.runtimeTokenId)
                        : t("activity.admin")
                    }
                    expanded={expandedResults.has(event.run.id)}
                    t={t}
                    onToggle={() => toggleResult(event.run!.id)}
                  />
                  {expandedResults.has(event.run.id) ? <RunDetail run={event.run} /> : null}
                </Fragment>
              );
            })
          )}
        </RowList>
        {activityError || canLoadMore ? (
          <div className="runs-page-footer">
            {activityError ? <InlineError message={activityError} /> : null}
            {canLoadMore ? (
              <div className="table-footer">
                <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loading}>
                  {loading ? <Loader2 size={14} className="spin" /> : null}
                  {t("runs.loadMore")}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  );
}

function RunRow(props: {
  run: RunLog;
  agentLabel: string;
  expanded: boolean;
  t: (key: string, params?: Record<string, unknown>) => string;
  onToggle(): void;
}): ReactNode {
  const { run } = props;
  const status = runActivityStatus(run);
  return (
    <Row
      onClick={props.onToggle}
      icon={
        <>
          <span className={ACTIVITY_CELLS.time}>{formatDateTime(run.startedAt)}</span>
          <span className={ACTIVITY_CELLS.agent}>{props.agentLabel}</span>
        </>
      }
      title={
        <span className={status === "ok" ? undefined : "activity-denied"}>{runRequestText(run, status, props.t)}</span>
      }
      cells={
        <>
          <span className={ACTIVITY_CELLS.connection}>
            {run.connectionProfile?.displayName ?? run.connectionId ?? run.service}
          </span>
          <span className={ACTIVITY_CELLS.result}>
            {status === "ok" ? (
              <Badge tone="success">{props.t("activity.statuses.ok")}</Badge>
            ) : status === "denied" ? (
              <Badge tone="error">{props.t("activity.statuses.denied")}</Badge>
            ) : (
              <Badge tone="error">{props.t("activity.statuses.failed")}</Badge>
            )}
          </span>
          <span className={ACTIVITY_CELLS.toggle}>
            {props.expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </span>
        </>
      }
    />
  );
}

function ApprovalRow(props: {
  approval: ApprovalRecord;
  agentLabel: string;
  t: (key: string, params?: Record<string, unknown>) => string;
}): ReactNode {
  const { approval, t } = props;
  const status = approvalActivityStatus(approval);
  return (
    <Row
      to={`/approvals/${encodeURIComponent(approval.id)}`}
      icon={
        <>
          <span className={ACTIVITY_CELLS.time}>{formatDateTime(approvalEventTime(approval))}</span>
          <span className={ACTIVITY_CELLS.agent}>{props.agentLabel}</span>
        </>
      }
      title={
        <span className={status === "denied" || status === "failed" ? "activity-denied" : undefined}>
          {approvalRequestText(approval, t)}
        </span>
      }
      cells={
        <>
          <span className={ACTIVITY_CELLS.connection}>
            {approval.connectionName ?? approval.connectionId ?? approval.service}
          </span>
          <span className={ACTIVITY_CELLS.result}>
            <Badge tone={approvalStatusTone(approval)}>{t(`approvals.status.${approval.status}`)}</Badge>
          </span>
          <span className={ACTIVITY_CELLS.toggle} />
        </>
      }
    />
  );
}

/**
 * The expanded run detail kept from the runs page: execution id, caller and
 * connection context, the policy verdict, the token, the error, the output
 * summary, and §4.6 receipts.
 */
function RunDetail(props: { run: RunLog }): ReactNode {
  const t = useTranslate();
  const run = props.run;
  const output = run.outputSummary == null ? "" : JSON.stringify(run.outputSummary);
  const policyCheck = run.policy?.checks.at(-1);
  return (
    <li className="row-detail">
      <div className="row-detail-meta">
        <span className="mono row-detail-id">
          {run.id}
          <CopyButton value={run.id} label={t("runs.copyExecutionId")} />
        </span>
        <span>
          {t("runs.table.context")}: <span className="mono">{run.caller}</span>
          {" · "}
          {run.connectionProfile?.displayName ?? run.connectionId ?? "-"}
        </span>
        {run.policy ? (
          <span className="mono">
            {t(run.policy.allowed ? "runs.policyAllowed" : "runs.policyBlocked")}
            {policyCheck
              ? ` · ${t(`access.policy.sources.${policyCheck.source}`)}${policyCheck.rule ? `: ${policyCheck.rule}` : ""}`
              : ""}
          </span>
        ) : null}
        {run.runtimeTokenId ? (
          <span className="mono">
            {t("runs.runtimeToken")}: {run.runtimeTokenId}
          </span>
        ) : null}
        {run.approvalId ? (
          <Link className="run-receipt-link" to={`/approvals/${encodeURIComponent(run.approvalId)}`}>
            {t("runs.viewApproval")}
          </Link>
        ) : null}
        {!run.ok && run.errorMessage ? <span>{run.errorMessage}</span> : null}
      </div>
      {output ? <pre className="run-result-detail">{JSON.stringify(run.outputSummary, null, 2)}</pre> : null}
      <RunReceipts run={run} />
    </li>
  );
}

/**
 * §4.6 receipts block inside a run's detail row: the custodian receipt claims
 * with a client-side verify against the served JWKS, and the Brand receipt's
 * stored verified state.
 */
function RunReceipts(props: { run: RunLog }): ReactNode {
  const t = useTranslate();
  const claims = useMemo(
    () => (props.run.receipt === undefined ? undefined : decodeJwsPayload(props.run.receipt)),
    [props.run.receipt],
  );
  const [verifyState, setVerifyState] = useState<"idle" | "pending" | "ok" | "failed">("idle");

  async function verify(): Promise<void> {
    if (props.run.receipt === undefined) return;
    setVerifyState("pending");
    try {
      setVerifyState((await verifyCustodianReceipt(props.run.receipt)) ? "ok" : "failed");
    } catch {
      setVerifyState("failed");
    }
  }

  if (!props.run.receipt && !props.run.providerReceipt) {
    return null;
  }
  const providerReceipt = props.run.providerReceipt;
  return (
    <div className="run-receipts">
      {props.run.receipt ? (
        <div className="run-receipt-row">
          <div className="run-receipt-head">
            <span className="run-receipt-title">{t("runs.receipts.custodian")}</span>
            <Button variant="outline" size="sm" onClick={() => void verify()} disabled={verifyState === "pending"}>
              {verifyState === "pending" ? <Loader2 size={13} className="spin" /> : null}
              {t("runs.receipts.verify")}
            </Button>
            {verifyState === "ok" ? <Badge tone="success">{t("runs.receipts.verified")}</Badge> : null}
            {verifyState === "failed" ? <Badge tone="error">{t("runs.receipts.verifyFailed")}</Badge> : null}
          </div>
          <pre className="run-result-detail run-receipt-json">
            {JSON.stringify(claims ?? props.run.receipt, null, 2)}
          </pre>
        </div>
      ) : null}
      {providerReceipt ? (
        <div className="run-receipt-row">
          <div className="run-receipt-head">
            <span className="run-receipt-title">{t("runs.receipts.provider")}</span>
            {providerReceipt.verified ? (
              <Badge tone="success">{t("runs.receipts.verified")}</Badge>
            ) : (
              <Badge tone="error">{t("runs.receipts.unverified")}</Badge>
            )}
            {providerReceipt.failureReason ? (
              <span className="run-secondary mono">{providerReceipt.failureReason}</span>
            ) : null}
          </div>
          {providerReceipt.claims ? (
            <pre className="run-result-detail run-receipt-json">{JSON.stringify(providerReceipt.claims, null, 2)}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Fetch the deployment's published JWKS (PACT identity route). */
async function readDeploymentJwks(): Promise<unknown> {
  const response = await fetch("/.well-known/jwks.json");
  return response.ok ? response.json() : {};
}

/** Decode a compact JWS's payload segment for display; undefined when malformed. */
export function decodeJwsPayload(jws: string): Record<string, unknown> | undefined {
  try {
    const parts = jws.split(".");
    if (parts.length !== 3) {
      return undefined;
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1])));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Client-side §4.6 check: verify the custodian receipt JWS against a key from
 * the deployment's served JWKS. Only ES256/P-256 keys verify — the algorithm
 * the custodian signs with.
 */
export async function verifyCustodianReceipt(
  jws: string,
  readJwks: () => Promise<unknown> = readDeploymentJwks,
): Promise<boolean> {
  try {
    const parts = jws.split(".");
    if (parts.length !== 3) {
      return false;
    }
    const header: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[0])));
    if (typeof header !== "object" || header === null) {
      return false;
    }
    const jwks = await readJwks();
    const keys = (jwks as { keys?: unknown }).keys;
    if (!Array.isArray(keys)) {
      return false;
    }
    const jwk = keys.find(
      (key): key is JsonWebKey =>
        typeof key === "object" && key !== null && (key as { kid?: unknown }).kid === (header as { kid?: unknown }).kid,
    );
    if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256") {
      return false;
    }
    const cryptoKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      cryptoKey,
      base64UrlToBytes(parts[2]) as BufferSource,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return false;
  }
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(`${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function ActivitySelect(props: {
  label: string;
  value: string;
  onChange(value: string): void;
  children: ReactNode;
}): ReactNode {
  return (
    <Select value={props.value} onValueChange={props.onChange}>
      <SelectTrigger className="select-filter run-select-filter" aria-label={props.label}>
        <span className="select-filter-label">{props.label}</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="select-filter-content" position="popper" align="start">
        {props.children}
      </SelectContent>
    </Select>
  );
}

// ---------------------------------------------------------------------------
// Feed model: runs and approvals merge into one time-ordered event list.

/** Merges runs and approvals into one feed sorted newest first. */
export function activityEvents(runs: RunLog[], approvals: ApprovalRecord[]): ActivityEvent[] {
  const events: ActivityEvent[] = [
    ...runs.map((run) => ({ id: `run-${run.id}`, kind: "run" as const, at: run.startedAt, run })),
    ...approvals.map((approval) => ({
      id: `approval-${approval.id}`,
      kind: "approval" as const,
      at: approvalEventTime(approval),
      approval,
    })),
  ];
  events.sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id));
  return events;
}

/** Approvals sit in the feed at their decision time; pending ones at request time. */
export function approvalEventTime(approval: ApprovalRecord): string {
  return approval.decidedAt ?? approval.createdAt;
}

export function runActivityStatus(run: RunLog): ActivityStatus {
  if (run.ok) return "ok";
  return isDeniedRun(run) ? "denied" : "failed";
}

export function approvalActivityStatus(approval: ApprovalRecord): ActivityStatus {
  switch (approval.status) {
    case "pending":
      return "pending";
    case "denied":
      return "denied";
    case "expired":
    case "failed":
      return "failed";
    default:
      return "ok";
  }
}

export function eventStatus(event: ActivityEvent): ActivityStatus {
  if (event.run) return runActivityStatus(event.run);
  return event.approval ? approvalActivityStatus(event.approval) : "ok";
}

export function eventAgentId(event: ActivityEvent): string | undefined {
  return event.run?.runtimeTokenId ?? event.approval?.runtimeTokenId;
}

export function eventConnectionId(event: ActivityEvent): string | undefined {
  return event.run?.connectionId ?? event.approval?.connectionId;
}

export function eventConnectionName(event: ActivityEvent): string | undefined {
  return event.run?.connectionProfile?.displayName ?? event.approval?.connectionName;
}

export function eventService(event: ActivityEvent): string {
  return event.run?.service ?? event.approval?.service ?? "";
}

export function eventActionId(event: ActivityEvent): string {
  return event.run?.actionId ?? event.approval?.actionId ?? "";
}

export function eventCaller(event: ActivityEvent): string | undefined {
  return event.run?.caller ?? event.approval?.caller;
}

export function eventApprovalId(event: ActivityEvent): string | undefined {
  return event.run?.approvalId ?? event.approval?.id;
}

function isDeniedRun(run: RunLog): boolean {
  if (run.policy?.allowed === false) return true;
  return run.errorCode !== undefined && deniedErrorCodes.has(run.errorCode);
}

/**
 * Every set filter must match for an event to stay in the feed. The
 * server-side subset (service/actionId/caller/ok on /api/runs, pending on
 * /api/approvals) already narrowed the window; the rest is client-side.
 */
export function activityEventMatches(
  event: ActivityEvent,
  filters: ActivityFilters,
  connections: readonly ConnectionRecord[] = [],
): boolean {
  if (filters.kind !== null && event.kind !== filters.kind) return false;
  if (filters.agent === adminAgentFilterValue) {
    if (eventAgentId(event) !== undefined) return false;
  } else if (filters.agent !== null && eventAgentId(event) !== filters.agent) {
    return false;
  }
  if (filters.connection !== null) {
    const targets = connectionMatchTargets(filters.connection, connections);
    const id = eventConnectionId(event);
    const name = eventConnectionName(event);
    const service = eventService(event);
    if (
      (id === undefined || !targets.has(id)) &&
      (name === undefined || !targets.has(name)) &&
      (service === "" || !targets.has(service))
    ) {
      return false;
    }
  }
  if (filters.status !== null && eventStatus(event) !== filters.status) return false;
  if (filters.approval !== null && eventApprovalId(event) !== filters.approval) return false;
  if (filters.actionId !== "" && eventActionId(event) !== filters.actionId) return false;
  if (filters.caller !== null && eventCaller(event) !== filters.caller) return false;
  if (filters.errorsOnly && !(event.run !== undefined && !event.run.ok)) return false;
  return true;
}

/** Runs API query: only the params the endpoint actually supports go server-side. */
export function activityRunsPath(input: {
  cursor?: string;
  filters: ActivityFilters;
  connectionService?: string;
}): string {
  const query = new URLSearchParams({ limit: String(activityPageLimit) });
  if (input.cursor) query.set("cursor", input.cursor);
  const { filters } = input;
  // `connection` accepts a connection id/name or a service; whichever form it
  // took, the resolved service is what the run list's `service` param narrows.
  if (filters.connection && input.connectionService !== undefined) query.set("service", input.connectionService);
  if (filters.actionId) query.set("actionId", filters.actionId);
  if (filters.caller) query.set("caller", filters.caller);
  if (filters.errorsOnly) query.set("ok", "false");
  else if (filters.status === "ok") query.set("ok", "true");
  else if (filters.status === "denied" || filters.status === "failed") query.set("ok", "false");
  return `/api/runs?${query}`;
}

/** Approvals API query: `pending` is the only server-side status filter. */
export function activityApprovalsPath(input: { cursor?: string; filters: ActivityFilters }): string {
  const query = new URLSearchParams({ status: input.filters.status === "pending" ? "pending" : "all" });
  if (input.cursor) query.set("cursor", input.cursor);
  return `/api/approvals?${query}`;
}

export function activityFiltersFromSearchParams(searchParams: URLSearchParams, preset?: ActivityKind): ActivityFilters {
  const statusParam = searchParams.get("status")?.trim();
  const okParam = searchParams.get("ok")?.trim();
  const kindParam = searchParams.get("kind")?.trim();
  const caller = searchParams.get("caller")?.trim();
  return {
    agent: searchParams.get("agent")?.trim() || null,
    // `service` is the legacy /runs spelling of the connection filter; the
    // param accepts connection ids, connection names, and service names alike.
    connection: searchParams.get("connection")?.trim() || searchParams.get("service")?.trim() || null,
    status:
      statusParam === "ok" || statusParam === "pending" || statusParam === "denied" || statusParam === "failed"
        ? statusParam
        : okParam === "true"
          ? "ok"
          : null,
    approval: searchParams.get("approval")?.trim() || null,
    kind: kindParam === "run" || kindParam === "approval" ? kindParam : (preset ?? null),
    actionId: searchParams.get("actionId")?.trim() || "",
    caller: caller === "http" || caller === "mcp" || caller === "web" ? caller : null,
    errorsOnly: okParam === "false",
  };
}

/** Agent select options: every known token plus ids seen only in the feed, then "admin". */
export function agentFilterOptions(
  tokens: RuntimeTokenSummary[],
  runs: RunLog[],
  approvals: ApprovalRecord[],
  t: (key: string) => string,
): Array<{ value: string; label: string }> {
  const options = new Map<string, string>();
  for (const token of tokens) {
    options.set(token.id, token.name || token.id);
  }
  for (const source of [...runs, ...approvals]) {
    if (source.runtimeTokenId !== undefined && !options.has(source.runtimeTokenId)) {
      options.set(source.runtimeTokenId, source.runtimeTokenId);
    }
  }
  const list = [...options.entries()].map(([value, label]) => ({ value, label }));
  list.push({ value: adminAgentFilterValue, label: t("activity.admin") });
  return list;
}

/** The configured connection a `connection` filter value names, by id, name, or service. */
export function findConfiguredConnection(
  target: string,
  connections: readonly ConnectionRecord[],
): ConnectionRecord | undefined {
  return connections.find(
    (connection) => connection.id === target || connection.service === target || connection.connectionName === target,
  );
}

/**
 * Every key an event may carry that the filter value should match: the raw
 * value, plus the resolved connection's id, service, and name. This is what
 * lets `?connection=<id>` still match events that never stored a connectionId
 * (denied/failed runs, approvals) and lets `?connection=<service>` match
 * events that did.
 */
export function connectionMatchTargets(target: string, connections: readonly ConnectionRecord[]): ReadonlySet<string> {
  const targets = new Set<string>([target]);
  const record = findConfiguredConnection(target, connections);
  if (record !== undefined) {
    if (record.id !== undefined) targets.add(record.id);
    targets.add(record.service);
    if (record.connectionName !== undefined) targets.add(record.connectionName);
  }
  return targets;
}

/** Connection select options: configured connections first, then bare services seen in the feed. */
export function connectionFilterOptions(
  connections: ConnectionRecord[],
  runs: RunLog[],
  approvals: ApprovalRecord[],
): Array<{ value: string; label: string }> {
  const options = new Map<string, string>();
  const services = new Set<string>();
  for (const connection of connections) {
    // Connection names repeat across providers (every virtual default is named
    // "default"), so the label always leads with the service.
    options.set(
      connection.id ?? connection.service,
      connection.connectionName ? `${connection.service} · ${connection.connectionName}` : connection.service,
    );
    services.add(connection.service);
  }
  for (const source of [...runs, ...approvals]) {
    if (!services.has(source.service) && !options.has(source.service)) {
      options.set(source.service, source.service);
      services.add(source.service);
    }
  }
  return [...options.entries()].map(([value, label]) => ({ value, label }));
}

function mergeApprovals(current: ApprovalRecord[], page: ApprovalRecord[]): ApprovalRecord[] {
  const seen = new Set(current.map((record) => record.id));
  return [...current, ...page.filter((record) => !seen.has(record.id))];
}

function approvalStatusTone(record: ApprovalRecord): "success" | "warning" | "error" | undefined {
  switch (record.status) {
    case "executed":
    case "approved":
      return "success";
    case "denied":
    case "failed":
      return "error";
    case "pending":
    case "executing":
    case "expired":
      return "warning";
    default:
      return undefined;
  }
}

function runRequestText(
  run: RunLog,
  status: ActivityStatus,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (status === "ok") return t("activity.request.ran", { action: run.actionId });
  const key = status === "denied" ? "activity.request.denied" : "activity.request.failed";
  return run.errorCode
    ? t(`${key}Reason`, { action: run.actionId, reason: run.errorCode })
    : t(key, { action: run.actionId });
}

function approvalRequestText(
  approval: ApprovalRecord,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  const base = t("activity.request.approval", { action: approval.actionId });
  switch (approval.status) {
    case "approved":
    case "executed":
      return `${base} → ${t("activity.decision.approved", { by: approval.decidedBy ?? "admin" })}`;
    case "denied":
      return `${base} → ${t("activity.decision.denied", { by: approval.decidedBy ?? "admin" })}`;
    case "executing":
      return `${base} → ${t("activity.decision.executing")}`;
    case "expired":
      return `${base} → ${t("activity.decision.expired")}`;
    case "failed":
      return `${base} → ${t("activity.decision.failed")}`;
    default:
      return base;
  }
}
