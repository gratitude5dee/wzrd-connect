import type {
  ApprovalDecisionResult,
  ApprovalGrant,
  ApprovalGrantList,
  ApprovalListPage,
  ApprovalRecord,
} from "./model";
import type { ReactNode, SubmitEvent } from "react";

import { useTranslate } from "@embra/i18n/react";
import { Check, Loader2, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { apiDelete, apiGet, apiPost } from "./api";
import { EmptyRows, Row, RowHeader, RowList } from "./components/row-list";
import { compactJson, formatDate } from "./model";
import { Badge, InlineError } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

// The column schema the inbox and history rows share: fixed-width cells fold
// away on narrow widths, and the last cell carries the decision or outcome.
const APPROVAL_CELLS = {
  caller: "hidden w-32 shrink-0 truncate text-muted-foreground lg:block",
  preview: "hidden w-56 shrink-0 truncate text-muted-foreground xl:block",
  operation: "w-24 shrink-0",
  expires: "hidden w-28 shrink-0 text-right text-muted-foreground tabular-nums md:block",
  action: "flex w-40 shrink-0 items-center justify-end",
};

const GRANT_CELLS = {
  connection: "hidden w-44 shrink-0 truncate text-muted-foreground md:block",
  uses: "w-16 shrink-0 text-right text-muted-foreground tabular-nums",
  operation: "w-24 shrink-0",
  expires: "hidden w-28 shrink-0 text-right text-muted-foreground tabular-nums md:block",
  action: "flex w-28 shrink-0 justify-end",
};

type ApprovalTab = "inbox" | "history" | "grants";

const approvalPollMs = 15_000;

export interface ApprovalsPageProps {
  onRefresh(): void;
}

export function ApprovalsPage(props: ApprovalsPageProps): ReactNode {
  const t = useTranslate();
  const params = useParams();
  const deepLinkId = params.approvalId;
  const [tab, setTab] = useState<ApprovalTab>("inbox");
  const [pending, setPending] = useState<ApprovalRecord[]>([]);
  const [history, setHistory] = useState<ApprovalRecord[]>([]);
  const [grants, setGrants] = useState<ApprovalGrant[]>([]);
  const [deepLinked, setDeepLinked] = useState<ApprovalRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [grantsLoaded, setGrantsLoaded] = useState(false);
  const [approveTarget, setApproveTarget] = useState<ApprovalRecord | null>(null);
  const [denyTarget, setDenyTarget] = useState<ApprovalRecord | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const page = await apiGet<ApprovalListPage>("/api/approvals?status=pending");
        if (cancelled) return;
        setPending(page.items);
        setError(null);
      } catch (caught) {
        if (cancelled) return;
        setError(readErrorMessage(caught, t("approvals.loadFailed")));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const timer = setInterval(() => void load(), approvalPollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [t]);

  useEffect(() => {
    if (!deepLinkId) {
      setDeepLinked(null);
      return;
    }
    let cancelled = false;
    apiGet<ApprovalRecord>(`/api/approvals/${deepLinkId}`)
      .then((record) => {
        if (!cancelled) setDeepLinked(record);
      })
      .catch(() => {
        if (!cancelled) setDeepLinked(null);
      });
    return () => {
      cancelled = true;
    };
  }, [deepLinkId]);

  useEffect(() => {
    if (tab === "history" && !historyLoaded) {
      void apiGet<ApprovalListPage>("/api/approvals?status=all")
        .then((page) => {
          setHistory(page.items);
          setHistoryLoaded(true);
        })
        .catch((caught) => setError(readErrorMessage(caught, t("approvals.loadFailed"))));
    }
    if (tab === "grants" && !grantsLoaded) {
      void apiGet<ApprovalGrantList>("/api/approval-grants")
        .then((list) => {
          setGrants(list.items);
          setGrantsLoaded(true);
        })
        .catch((caught) => setError(readErrorMessage(caught, t("approvals.loadFailed"))));
    }
  }, [tab, historyLoaded, grantsLoaded, t]);

  async function refreshAll(): Promise<void> {
    try {
      const [page, grantList] = await Promise.all([
        apiGet<ApprovalListPage>("/api/approvals?status=pending"),
        apiGet<ApprovalGrantList>("/api/approval-grants"),
      ]);
      setPending(page.items);
      setGrants(grantList.items);
      setHistoryLoaded(false);
      setError(null);
      props.onRefresh();
    } catch (caught) {
      setError(readErrorMessage(caught, t("approvals.loadFailed")));
    }
  }

  function onDecided(): void {
    setApproveTarget(null);
    setDenyTarget(null);
    void refreshAll();
  }

  const inbox = deepLinked?.status === "pending" ? mergeRecord(pending, deepLinked) : pending;

  return (
    <section className="runs-panel">
      <div className="tab-row approvals-toolbar">
        <div>
          <h2>{t("approvals.title")}</h2>
          <p className="muted-copy">{t("approvals.description")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refreshAll()} disabled={loading}>
          {loading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
          {t("common.refresh")}
        </Button>
      </div>
      {error ? <InlineError message={error} /> : null}
      {deepLinked && deepLinked.status !== "pending" ? <ApprovalDetailCard record={deepLinked} /> : null}
      <Tabs value={tab} onValueChange={(value) => setTab(value as ApprovalTab)}>
        <TabsList>
          <TabsTrigger value="inbox">
            {t("approvals.tabs.inbox")}
            {pending.length > 0 ? <Badge tone="warning">{pending.length}</Badge> : null}
          </TabsTrigger>
          <TabsTrigger value="history">{t("approvals.tabs.history")}</TabsTrigger>
          <TabsTrigger value="grants">{t("approvals.tabs.grants")}</TabsTrigger>
        </TabsList>
        <TabsContent value="inbox">
          {loading && inbox.length === 0 ? (
            <div className="loading-panel">
              <Loader2 className="spin" size={16} /> {t("common.loadingRuntimeData")}
            </div>
          ) : (
            <ApprovalTable
              records={inbox}
              highlightId={deepLinkId}
              pendingOnly
              empty={`${t("approvals.inboxEmpty")} ${t("approvals.inboxEmptyHint")}`}
              onApprove={setApproveTarget}
              onDeny={setDenyTarget}
            />
          )}
        </TabsContent>
        <TabsContent value="history">
          {!historyLoaded ? (
            <div className="loading-panel">
              <Loader2 className="spin" size={16} /> {t("common.loadingRuntimeData")}
            </div>
          ) : (
            <ApprovalTable
              records={history}
              highlightId={deepLinkId}
              empty={`${t("approvals.historyEmpty")} ${t("approvals.historyEmptyHint")}`}
            />
          )}
        </TabsContent>
        <TabsContent value="grants">
          {!grantsLoaded ? (
            <div className="loading-panel">
              <Loader2 className="spin" size={16} /> {t("common.loadingRuntimeData")}
            </div>
          ) : (
            <GrantsTable
              grants={grants}
              empty={`${t("approvals.grantsEmpty")} ${t("approvals.grantsEmptyHint")}`}
              onRevoked={refreshAll}
              onError={(message) => setError(message)}
            />
          )}
        </TabsContent>
      </Tabs>
      {approveTarget ? (
        <ApproveDialog record={approveTarget} onClose={() => setApproveTarget(null)} onDecided={onDecided} />
      ) : null}
      {denyTarget ? <DenyDialog record={denyTarget} onClose={() => setDenyTarget(null)} onDecided={onDecided} /> : null}
    </section>
  );
}

function mergeRecord(records: ApprovalRecord[], record: ApprovalRecord): ApprovalRecord[] {
  return records.some((item) => item.id === record.id) ? records : [record, ...records];
}

function readErrorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof Error) return caught.message;
  return fallback;
}

function statusTone(record: ApprovalRecord): "success" | "warning" | "error" | undefined {
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

interface ApprovalTableProps {
  records: ApprovalRecord[];
  empty: string;
  highlightId?: string;
  pendingOnly?: boolean;
  onApprove?: (record: ApprovalRecord) => void;
  onDeny?: (record: ApprovalRecord) => void;
}

function ApprovalTable(props: ApprovalTableProps): ReactNode {
  const t = useTranslate();
  return (
    <RowList
      header={
        <RowHeader>
          <span className="min-w-0 flex-1 truncate">{t("approvals.columns.action")}</span>
          <span className={APPROVAL_CELLS.caller}>{t("approvals.columns.caller")}</span>
          <span className={APPROVAL_CELLS.preview}>{t("approvals.columns.preview")}</span>
          <span className={APPROVAL_CELLS.operation}>{t("approvals.columns.operation")}</span>
          <span className={APPROVAL_CELLS.expires}>{t("approvals.columns.expires")}</span>
          <span className={APPROVAL_CELLS.action}>
            {t(props.pendingOnly ? "approvals.columns.decision" : "approvals.columns.status")}
          </span>
        </RowHeader>
      }
    >
      {props.records.length === 0 ? (
        <EmptyRows>{props.empty}</EmptyRows>
      ) : (
        props.records.map((record) => (
          <Row
            key={record.id}
            highlighted={record.id === props.highlightId}
            title={
              <span className="approval-action">
                <code>{record.actionId}</code>
                {record.kind === "proxy" ? <Badge>{t("approvals.proxyKind")}</Badge> : null}
              </span>
            }
            cells={
              <>
                <span className={APPROVAL_CELLS.caller}>{record.caller}</span>
                <span className={APPROVAL_CELLS.preview}>
                  <code className="approval-preview">{compactJson(record.preview)}</code>
                </span>
                <span className={APPROVAL_CELLS.operation}>
                  <Badge tone={record.operationType === "destructive" ? "error" : undefined}>
                    {record.operationType}
                  </Badge>
                </span>
                <span className={APPROVAL_CELLS.expires}>{formatDate(record.expiresAt)}</span>
                <span className={APPROVAL_CELLS.action}>
                  {props.pendingOnly ? (
                    <div className="button-row">
                      <Button size="sm" onClick={() => props.onApprove?.(record)}>
                        <Check size={14} />
                        {t("approvals.approve")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => props.onDeny?.(record)}>
                        <X size={14} />
                        {t("approvals.deny")}
                      </Button>
                    </div>
                  ) : (
                    <Badge tone={statusTone(record)}>{t(`approvals.status.${record.status}`)}</Badge>
                  )}
                </span>
              </>
            }
          />
        ))
      )}
    </RowList>
  );
}

interface GrantsTableProps {
  grants: ApprovalGrant[];
  empty: string;
  onRevoked(): void;
  onError(message: string): void;
}

function GrantsTable(props: GrantsTableProps): ReactNode {
  const t = useTranslate();
  const [revoking, setRevoking] = useState<string | null>(null);

  async function revoke(id: string): Promise<void> {
    setRevoking(id);
    try {
      await apiDelete(`/api/approval-grants/${id}`);
      props.onRevoked();
    } catch (caught) {
      props.onError(readErrorMessage(caught, t("approvals.revokeFailed")));
    } finally {
      setRevoking(null);
    }
  }

  return (
    <RowList
      header={
        <RowHeader>
          <span className="min-w-0 flex-1 truncate">{t("approvals.columns.action")}</span>
          <span className={GRANT_CELLS.connection}>{t("approvals.columns.connection")}</span>
          <span className={GRANT_CELLS.uses}>{t("approvals.grants.uses")}</span>
          <span className={GRANT_CELLS.operation}>{t("approvals.columns.operation")}</span>
          <span className={GRANT_CELLS.expires}>{t("approvals.columns.expires")}</span>
          <span className={GRANT_CELLS.action} />
        </RowHeader>
      }
    >
      {props.grants.length === 0 ? (
        <EmptyRows>{props.empty}</EmptyRows>
      ) : (
        props.grants.map((grant) => (
          <Row
            key={grant.id}
            title={<code>{grant.actionId}</code>}
            cells={
              <>
                <span className={GRANT_CELLS.connection}>{grant.connectionId ?? "—"}</span>
                <span className={GRANT_CELLS.uses}>
                  {grant.uses}/{grant.maxUses === 0 ? "∞" : grant.maxUses}
                </span>
                <span className={GRANT_CELLS.operation}>
                  <Badge tone={grant.operationType === "destructive" ? "error" : undefined}>
                    {grant.operationType}
                  </Badge>
                </span>
                <span className={GRANT_CELLS.expires}>{formatDate(grant.expiresAt)}</span>
                <span className={GRANT_CELLS.action}>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={revoking === grant.id}
                    onClick={() => void revoke(grant.id)}
                  >
                    {revoking === grant.id ? <Loader2 className="spin" size={14} /> : <X size={14} />}
                    {t("approvals.grants.revoke")}
                  </Button>
                </span>
              </>
            }
          />
        ))
      )}
    </RowList>
  );
}

interface ApproveDialogProps {
  record: ApprovalRecord;
  onClose(): void;
  onDecided(): void;
}

function ApproveDialog(props: ApproveDialogProps): ReactNode {
  const t = useTranslate();
  const [grantEnabled, setGrantEnabled] = useState(false);
  const [ttlMinutes, setTtlMinutes] = useState("30");
  const [maxUses, setMaxUses] = useState("1");
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenScoped = Boolean(props.record.runtimeTokenId);
  const destructive = props.record.operationType === "destructive";

  async function submit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const grant = grantEnabled
      ? {
          ttlMinutes: Number(ttlMinutes),
          maxUses: Number(maxUses),
          allowDestructive: destructive ? allowDestructive : undefined,
        }
      : undefined;
    try {
      await apiPost<ApprovalDecisionResult>(`/api/approvals/${props.record.id}/approve`, { grant });
      props.onDecided();
    } catch (caught) {
      setError(readErrorMessage(caught, t("approvals.approveFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? props.onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("approvals.approveTitle")}</DialogTitle>
          <DialogDescription>{t("approvals.approveDescription", { action: props.record.actionId })}</DialogDescription>
        </DialogHeader>
        <form className="form-grid" onSubmit={(event) => void submit(event)}>
          {tokenScoped ? (
            <Label className="field field-checkbox">
              <input
                type="checkbox"
                checked={grantEnabled}
                onChange={(event) => setGrantEnabled(event.target.checked)}
              />
              <span>{t("approvals.grantToggle")}</span>
            </Label>
          ) : (
            <p className="muted-copy">{t("approvals.grantUnavailable")}</p>
          )}
          {grantEnabled && tokenScoped ? (
            <>
              <Label className="field">
                <span>{t("approvals.grantTtl")}</span>
                <Input
                  type="number"
                  min={1}
                  max={1440}
                  value={ttlMinutes}
                  onChange={(event) => setTtlMinutes(event.target.value)}
                />
              </Label>
              <Label className="field">
                <span>{t("approvals.grantMaxUses")}</span>
                <Input type="number" min={0} value={maxUses} onChange={(event) => setMaxUses(event.target.value)} />
              </Label>
              {destructive ? (
                <Label className="field field-checkbox">
                  <input
                    type="checkbox"
                    checked={allowDestructive}
                    onChange={(event) => setAllowDestructive(event.target.checked)}
                  />
                  <span>{t("approvals.grantAllowDestructive")}</span>
                </Label>
              ) : null}
            </>
          ) : null}
          {error ? <InlineError message={error} /> : null}
          <div className="button-row">
            <Button variant="outline" type="button" onClick={props.onClose} disabled={busy}>
              {t("common.close")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="spin" size={15} /> : <ShieldCheck size={15} />}
              {t("approvals.approve")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface DenyDialogProps {
  record: ApprovalRecord;
  onClose(): void;
  onDecided(): void;
}

function DenyDialog(props: DenyDialogProps): ReactNode {
  const t = useTranslate();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost<ApprovalDecisionResult>(`/api/approvals/${props.record.id}/deny`, {
        reason: reason.trim() || undefined,
      });
      props.onDecided();
    } catch (caught) {
      setError(readErrorMessage(caught, t("approvals.denyFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? props.onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("approvals.denyTitle")}</DialogTitle>
          <DialogDescription>{t("approvals.denyDescription", { action: props.record.actionId })}</DialogDescription>
        </DialogHeader>
        <form className="form-grid" onSubmit={(event) => void submit(event)}>
          <Label className="field">
            <span>{t("approvals.denyReason")}</span>
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} />
          </Label>
          {error ? <InlineError message={error} /> : null}
          <div className="button-row">
            <Button variant="outline" type="button" onClick={props.onClose} disabled={busy}>
              {t("common.close")}
            </Button>
            <Button type="submit" variant="destructive" disabled={busy}>
              {busy ? <Loader2 className="spin" size={15} /> : <X size={15} />}
              {t("approvals.deny")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ApprovalDetailCard(props: { record: ApprovalRecord }): ReactNode {
  const t = useTranslate();
  const record = props.record;
  return (
    <section className="example-card approval-detail">
      <div className="tab-row">
        <strong>
          <code>{record.actionId}</code>
        </strong>
        <Badge tone={statusTone(record)}>{t(`approvals.status.${record.status}`)}</Badge>
      </div>
      <dl className="approval-detail-fields">
        <dt>{t("approvals.columns.operation")}</dt>
        <dd>{record.operationType}</dd>
        <dt>{t("approvals.columns.connection")}</dt>
        <dd>{record.connectionName ?? record.service}</dd>
        <dt>{t("approvals.columns.caller")}</dt>
        <dd>{record.caller}</dd>
        {record.decisionReason ? (
          <>
            <dt>{t("approvals.decisionReason")}</dt>
            <dd>{record.decisionReason}</dd>
          </>
        ) : null}
        {record.grantId ? (
          <>
            <dt>{t("approvals.grant")}</dt>
            <dd>
              <code>{record.grantId}</code>
            </dd>
          </>
        ) : null}
      </dl>
      <pre className="approval-preview-block">{compactJson(record.preview)}</pre>
    </section>
  );
}
