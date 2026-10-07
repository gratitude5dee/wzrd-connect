import type { RunLog, RunLogPage } from "./model";
import type { ReactNode, SubmitEvent } from "react";

import { useTranslate } from "@embra/i18n/react";
import { ChevronDown, ChevronUp, Copy, Loader2, Search } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { apiGet } from "./api";
import { compactJson, formatDate, formatDuration } from "./model";
import { Badge, EmptyState, InlineError } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface RunsPageProps {
  initialRuns: RunLog[];
  nextCursor?: string;
}

interface RunServiceOption {
  service: string;
  count: number;
}

export interface RunFilters {
  service: string | null;
  actionId: string;
  caller: RunLog["caller"] | null;
  ok: boolean | null;
}

const allServicesFilterValue = "__all_services__";
const allCallersFilterValue = "__all_callers__";
const allStatusesFilterValue = "__all_statuses__";
const runPageLimit = 50;

export function RunsPage(props: RunsPageProps): ReactNode {
  const t = useTranslate();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = runFiltersFromSearchParams(searchParams);
  const [runs, setRuns] = useState(props.initialRuns);
  const [nextCursor, setNextCursor] = useState(props.nextCursor);
  const [actionDraft, setActionDraft] = useState(filters.actionId);
  const [loading, setLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [expandedResults, setExpandedResults] = useState<Set<string>>(() => new Set());
  const requestGeneration = useRef(0);
  const serviceOptions = useMemo(() => runServiceOptions([...props.initialRuns, ...runs]), [props.initialRuns, runs]);
  const callerOptions = useMemo(
    () => [...new Set([...props.initialRuns, ...runs].map((run) => run.caller))],
    [props.initialRuns, runs],
  );
  const hasFilters = Boolean(filters.service || filters.actionId || filters.caller || filters.ok !== null);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    setActionDraft(filters.actionId);
    setRunsError(null);
    if (!hasFilters) {
      setRuns(props.initialRuns);
      setNextCursor(props.nextCursor);
      setLoading(false);
      return;
    }
    void loadFilteredRuns(filters, generation);
  }, [props.initialRuns, props.nextCursor, searchParams]);

  async function loadFilteredRuns(nextFilters: RunFilters, generation: number): Promise<void> {
    setLoading(true);
    setRuns([]);
    setNextCursor(undefined);
    try {
      const page = await apiGet<RunLogPage>(runListPath({ filters: nextFilters }));
      if (generation !== requestGeneration.current) return;
      setRuns(page.items);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (generation !== requestGeneration.current) return;
      setRunsError(caught instanceof Error ? caught.message : t("runs.loadMoreFailed"));
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }

  async function loadMoreRuns(): Promise<void> {
    if (!nextCursor || loading) return;
    const generation = ++requestGeneration.current;
    setLoading(true);
    setRunsError(null);
    try {
      const page = await apiGet<RunLogPage>(runListPath({ cursor: nextCursor, filters }));
      if (generation !== requestGeneration.current) return;
      setRuns((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (generation !== requestGeneration.current) return;
      setRunsError(caught instanceof Error ? caught.message : t("runs.loadMoreFailed"));
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }

  function updateFilter(name: keyof RunFilters, value: string | null): void {
    requestGeneration.current += 1;
    setLoading(false);
    const next = new URLSearchParams(searchParams);
    if (value === null || value === "") next.delete(name);
    else next.set(name, value);
    setSearchParams(next);
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

  return (
    <TooltipProvider>
      <div className="page-stack runs-page">
        <section className="page-toolbar runs-toolbar">
          <form className="run-action-filter" onSubmit={submitActionFilter}>
            <Input
              value={actionDraft}
              onChange={(event) => setActionDraft(event.target.value)}
              placeholder={t("runs.actionPlaceholder")}
              aria-label={t("runs.action")}
            />
            <Button type="submit" variant="outline" size="icon-sm" aria-label={t("runs.applyActionFilter")}>
              <Search size={14} />
            </Button>
          </form>
          <RunSelect
            label={t("runs.service")}
            value={filters.service ?? allServicesFilterValue}
            onChange={(value) => updateFilter("service", value === allServicesFilterValue ? null : value)}
          >
            <SelectItem value={allServicesFilterValue}>{t("runs.allServices")}</SelectItem>
            {serviceOptions.map((option) => (
              <SelectItem key={option.service} value={option.service}>
                {option.service} ({option.count})
              </SelectItem>
            ))}
          </RunSelect>
          <RunSelect
            label={t("runs.caller")}
            value={filters.caller ?? allCallersFilterValue}
            onChange={(value) => updateFilter("caller", value === allCallersFilterValue ? null : value)}
          >
            <SelectItem value={allCallersFilterValue}>{t("runs.allCallers")}</SelectItem>
            {callerOptions.map((caller) => (
              <SelectItem key={caller} value={caller}>
                {caller}
              </SelectItem>
            ))}
          </RunSelect>
          <RunSelect
            label={t("runs.status")}
            value={filters.ok === null ? allStatusesFilterValue : String(filters.ok)}
            onChange={(value) => updateFilter("ok", value === allStatusesFilterValue ? null : value)}
          >
            <SelectItem value={allStatusesFilterValue}>{t("runs.allStatuses")}</SelectItem>
            <SelectItem value="true">{t("common.success")}</SelectItem>
            <SelectItem value="false">{t("common.failed")}</SelectItem>
          </RunSelect>
        </section>

        <section className="table-panel">
          {runs.length === 0 ? (
            <EmptyState title={t("runs.noRunsTitle")} description={t("runs.noRunsDescription")} icon={null} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="run-col-timing">{t("runs.table.timing")}</TableHead>
                  <TableHead className="run-col-status">{t("runs.table.status")}</TableHead>
                  <TableHead className="run-col-action">{t("runs.table.action")}</TableHead>
                  <TableHead className="run-col-context">{t("runs.table.context")}</TableHead>
                  <TableHead className="run-col-summary">{t("runs.table.input")}</TableHead>
                  <TableHead className="run-col-summary">{t("runs.table.result")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => {
                  const expanded = expandedResults.has(run.id);
                  const output = run.outputSummary == null ? "" : JSON.stringify(run.outputSummary);
                  const hasReceiptData = Boolean(run.approvalId ?? run.receipt ?? run.providerReceipt);
                  const expandable = output.length > 120 || hasReceiptData;
                  const policyCheck = run.policy?.checks.at(-1);
                  return (
                    <Fragment key={run.id}>
                      <TableRow>
                        <TableCell className="run-col-timing">
                          <div className="run-primary">{formatDate(run.startedAt)}</div>
                          <div className="run-secondary">{formatDuration(run)}</div>
                        </TableCell>
                        <TableCell className="run-col-status">
                          {run.ok ? (
                            <Badge tone="success">{t("common.success")}</Badge>
                          ) : (
                            <Badge tone="error">{t("common.failed")}</Badge>
                          )}
                        </TableCell>
                        <TableCell className="run-col-action">
                          <div className="run-primary mono">{run.actionId}</div>
                          <div className="run-secondary mono">
                            <span>{run.id}</span>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={t("runs.copyExecutionId")}
                                  onClick={() => void navigator.clipboard.writeText(run.id)}
                                >
                                  <Copy size={13} />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{t("runs.copyExecutionId")}</TooltipContent>
                            </Tooltip>
                          </div>
                        </TableCell>
                        <TableCell className="run-col-context">
                          <div className="run-primary mono">{run.caller}</div>
                          <div className="run-secondary">
                            {run.connectionProfile?.displayName ?? run.connectionId ?? "-"}
                          </div>
                          {run.policy ? (
                            <div className="run-secondary mono">
                              {t(run.policy.allowed ? "runs.policyAllowed" : "runs.policyBlocked")}
                              {policyCheck
                                ? ` · ${t(`access.policy.sources.${policyCheck.source}`)}${policyCheck.rule ? `: ${policyCheck.rule}` : ""}`
                                : ""}
                            </div>
                          ) : null}
                          {run.runtimeTokenId ? (
                            <div className="run-secondary mono">
                              {t("runs.runtimeToken")}: {run.runtimeTokenId}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="mono run-summary run-col-summary">
                          {compactJson(run.inputSummary)}
                        </TableCell>
                        <TableCell className="mono run-summary run-col-summary">
                          {run.ok ? (
                            <div className="run-result">
                              <pre>{output}</pre>
                              {expandable ? (
                                <ResultToggle expanded={expanded} onToggle={() => toggleResult(run.id)} />
                              ) : null}
                            </div>
                          ) : (
                            <div className="run-result">
                              <div>
                                <div className="run-primary">{run.errorCode ?? "-"}</div>
                                {run.errorMessage ? <div className="run-secondary">{run.errorMessage}</div> : null}
                              </div>
                              {expandable ? (
                                <ResultToggle expanded={expanded} onToggle={() => toggleResult(run.id)} />
                              ) : null}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                      {expanded ? (
                        <TableRow className="run-result-detail-row">
                          <TableCell colSpan={6}>
                            {output ? (
                              <pre className="run-result-detail">{JSON.stringify(run.outputSummary, null, 2)}</pre>
                            ) : null}
                            <RunReceipts run={run} />
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </section>
        {runsError || nextCursor ? (
          <div className="runs-page-footer">
            {runsError ? <InlineError message={runsError} /> : null}
            {nextCursor ? (
              <div className="table-footer">
                <Button variant="outline" size="sm" onClick={() => void loadMoreRuns()} disabled={loading}>
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

function ResultToggle(props: { expanded: boolean; onToggle(): void }): ReactNode {
  const t = useTranslate();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t(props.expanded ? "runs.collapseResult" : "runs.expandResult")}
          aria-expanded={props.expanded}
          onClick={props.onToggle}
        >
          {props.expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t(props.expanded ? "runs.collapseResult" : "runs.expandResult")}</TooltipContent>
    </Tooltip>
  );
}

/**
 * §4.6 receipts block inside a run's detail row: the §4.2 approval deep link,
 * the custodian receipt claims with a client-side verify against the served
 * JWKS, and the Brand receipt's stored verified state.
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

  if (!props.run.approvalId && !props.run.receipt && !props.run.providerReceipt) {
    return null;
  }
  const providerReceipt = props.run.providerReceipt;
  return (
    <div className="run-receipts">
      {props.run.approvalId ? (
        <div className="run-receipt-row">
          <Link className="run-receipt-link" to={`/approvals/${props.run.approvalId}`}>
            {t("runs.viewApproval")}
          </Link>
        </div>
      ) : null}
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

function RunSelect(props: {
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

export function runServiceOptions(runs: RunLog[]): RunServiceOption[] {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const run of runs) {
    if (seen.has(run.id)) continue;
    seen.add(run.id);
    counts.set(run.service, (counts.get(run.service) ?? 0) + 1);
  }
  return [...counts.entries()].map(([service, count]) => ({ service, count }));
}

export function runListPath(input: { cursor?: string; filters: RunFilters }): string {
  const query = new URLSearchParams({ limit: String(runPageLimit) });
  if (input.cursor) query.set("cursor", input.cursor);
  if (input.filters.service) query.set("service", input.filters.service);
  if (input.filters.actionId) query.set("actionId", input.filters.actionId);
  if (input.filters.caller) query.set("caller", input.filters.caller);
  if (input.filters.ok !== null) query.set("ok", String(input.filters.ok));
  return `/api/runs?${query}`;
}

export function runFiltersFromSearchParams(searchParams: URLSearchParams): RunFilters {
  const caller = searchParams.get("caller")?.trim();
  const ok = searchParams.get("ok")?.trim();
  return {
    service: searchParams.get("service")?.trim() || null,
    actionId: searchParams.get("actionId")?.trim() || "",
    caller: caller === "http" || caller === "mcp" || caller === "web" ? caller : null,
    ok: ok === "true" ? true : ok === "false" ? false : null,
  };
}
