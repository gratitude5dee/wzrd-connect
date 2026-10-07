import type {
  PactIdentity,
  PactIdentityResponse,
  PactRegistration,
  PactRegistrationList,
  PactRegistrationResponse,
  PactRegistrationTokenResponse,
} from "./model";
import type { ReactNode, SubmitEvent } from "react";

import { useTranslate } from "@embra/i18n/react";
import { Copy, KeyRound, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";
import { formatDate } from "./model";
import { Badge, EmptyState, InlineError } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

export interface PactPageProps {
  onRefresh(): void;
}

export function PactPage(_props: PactPageProps): ReactNode {
  const t = useTranslate();
  const [identity, setIdentity] = useState<PactIdentity | null>(null);
  const [registrations, setRegistrations] = useState<PactRegistration[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<PactRegistration | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [copiedKid, setCopiedKid] = useState(false);

  async function load(): Promise<void> {
    try {
      const [identityResult, registrationList] = await Promise.all([
        apiGet<PactIdentityResponse>("/api/pact/identity"),
        apiGet<PactRegistrationList>("/api/pact/registrations"),
      ]);
      setIdentity(identityResult.identity);
      setRegistrations(registrationList.items);
      setError(null);
    } catch (caught) {
      setError(readErrorMessage(caught, t("pact.loadFailed")));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  async function run(action: string, work: () => Promise<unknown>): Promise<void> {
    setBusyAction(action);
    setError(null);
    try {
      await work();
      await load();
    } catch (caught) {
      setError(readErrorMessage(caught, t("pact.loadFailed")));
    } finally {
      setBusyAction(null);
    }
  }

  function copyKid(kid: string): void {
    void navigator.clipboard?.writeText(kid).then(() => {
      setCopiedKid(true);
      setTimeout(() => setCopiedKid(false), 1500);
    });
  }

  return (
    <section className="runs-panel">
      <div className="tab-row approvals-toolbar">
        <div>
          <h2>{t("pact.title")}</h2>
          <p className="muted-copy">{t("pact.description")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
          {t("common.refresh")}
        </Button>
      </div>
      {error ? <InlineError message={error} /> : null}

      <section className="example-card">
        <div className="tab-row">
          <h3>{t("pact.identity.heading")}</h3>
          {identity ? (
            <div className="button-row">
              <Button
                variant="outline"
                size="sm"
                disabled={busyAction === "rotate"}
                onClick={() => void run("rotate", () => apiPost("/api/pact/identity/rotate", {}))}
              >
                {busyAction === "rotate" ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                {t("pact.identity.rotate")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setTokenOpen(true)}>
                <KeyRound size={14} />
                {t("pact.identity.registrationToken")}
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              disabled={busyAction === "create"}
              onClick={() => void run("create", () => apiPost("/api/pact/identity", {}))}
            >
              {busyAction === "create" ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
              {t("pact.identity.create")}
            </Button>
          )}
        </div>
        {identity ? (
          <dl className="approval-detail-fields">
            <dt>{t("pact.identity.kid")}</dt>
            <dd>
              <code>{identity.kid}</code>{" "}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copyKid(identity.kid)}
                title={t("pact.identity.copyKid")}
              >
                <Copy size={12} />
                {copiedKid ? t("pact.identity.copied") : null}
              </Button>
            </dd>
            <dt>{t("pact.identity.issuer")}</dt>
            <dd>
              <code>{identity.issuer ?? "—"}</code>
            </dd>
            <dt>{t("pact.identity.jwksUrl")}</dt>
            <dd>
              <code>{identity.jwksUrl ?? "—"}</code>
            </dd>
            <dt>{t("pact.identity.subject")}</dt>
            <dd>
              <code>{identity.subject}</code>
            </dd>
            <dt>{t("pact.identity.createdAt")}</dt>
            <dd>{formatDate(identity.createdAt)}</dd>
            {identity.rotatedAt ? (
              <>
                <dt>{t("pact.identity.rotatedAt")}</dt>
                <dd>{formatDate(identity.rotatedAt)}</dd>
              </>
            ) : null}
            {identity.previousKid ? (
              <>
                <dt>{t("pact.identity.previousKid")}</dt>
                <dd>
                  <code>{identity.previousKid}</code> <Badge>{t("pact.identity.graceBadge")}</Badge>
                </dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="muted-copy">{t("pact.identity.empty")}</p>
        )}
      </section>

      <section className="example-card">
        <div className="tab-row">
          <h3>{t("pact.registrations.heading")}</h3>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} />
            {t("pact.registrations.add")}
          </Button>
        </div>
        {registrations.length === 0 ? (
          <EmptyState title={t("pact.registrations.empty")} description={t("pact.registrations.emptyHint")} />
        ) : (
          <div className="table-wrap">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("pact.registrations.columns.origin")}</TableHead>
                  <TableHead>{t("pact.registrations.columns.audience")}</TableHead>
                  <TableHead>{t("pact.registrations.columns.status")}</TableHead>
                  <TableHead>{t("pact.registrations.columns.notes")}</TableHead>
                  <TableHead>{t("pact.registrations.columns.updated")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {registrations.map((registration) => (
                  <RegistrationRow
                    key={registration.id}
                    registration={registration}
                    busy={busyAction === `registration:${registration.id}`}
                    onEdit={() => setEditTarget(registration)}
                    onToggle={() =>
                      void run(`registration:${registration.id}`, () =>
                        apiPut(`/api/pact/registrations/${registration.id}`, { enabled: !registration.enabled }),
                      )
                    }
                    onDelete={() =>
                      void run(`registration:${registration.id}`, () =>
                        apiDelete(`/api/pact/registrations/${registration.id}`),
                      )
                    }
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {createOpen ? (
        <RegistrationDialog
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false);
            void load();
          }}
        />
      ) : null}
      {editTarget ? (
        <RegistrationDialog
          registration={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null);
            void load();
          }}
        />
      ) : null}
      {tokenOpen ? <RegistrationTokenDialog onClose={() => setTokenOpen(false)} /> : null}
    </section>
  );
}

interface RegistrationRowProps {
  registration: PactRegistration;
  busy: boolean;
  onEdit(): void;
  onToggle(): void;
  onDelete(): void;
}

function RegistrationRow(props: RegistrationRowProps): ReactNode {
  const t = useTranslate();
  const registration = props.registration;
  return (
    <TableRow>
      <TableCell>
        <code>{registration.providerOrigin}</code>
      </TableCell>
      <TableCell>
        <code>{registration.audience}</code>
      </TableCell>
      <TableCell>
        <Button variant="ghost" size="sm" onClick={props.onToggle} disabled={props.busy}>
          <Badge tone={registration.enabled ? "success" : undefined}>
            {registration.enabled ? t("pact.registrations.enabled") : t("pact.registrations.disabled")}
          </Badge>
        </Button>
      </TableCell>
      <TableCell>{registration.notes ?? "—"}</TableCell>
      <TableCell>{formatDate(registration.updatedAt)}</TableCell>
      <TableCell>
        <div className="button-row">
          <Button variant="outline" size="sm" onClick={props.onEdit} disabled={props.busy}>
            <Pencil size={13} />
          </Button>
          <Button variant="outline" size="sm" onClick={props.onDelete} disabled={props.busy}>
            {props.busy ? <Loader2 className="spin" size={13} /> : <Trash2 size={13} />}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

interface RegistrationDialogProps {
  registration?: PactRegistration;
  onClose(): void;
  onSaved(): void;
}

function RegistrationDialog(props: RegistrationDialogProps): ReactNode {
  const t = useTranslate();
  const editing = props.registration;
  const [providerOrigin, setProviderOrigin] = useState(editing?.providerOrigin ?? "");
  const [audience, setAudience] = useState(editing?.audience ?? "");
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      providerOrigin: providerOrigin.trim(),
      audience: audience.trim(),
      enabled,
      notes: notes.trim() || undefined,
    };
    try {
      if (editing) {
        await apiPut<PactRegistrationResponse>(`/api/pact/registrations/${editing.id}`, body);
      } else {
        await apiPost<PactRegistrationResponse>("/api/pact/registrations", body);
      }
      props.onSaved();
    } catch (caught) {
      setError(readErrorMessage(caught, t("pact.registrations.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? props.onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? t("pact.registrations.editTitle") : t("pact.registrations.addTitle")}</DialogTitle>
          <DialogDescription>{t("pact.registrations.description")}</DialogDescription>
        </DialogHeader>
        <form className="form-grid" onSubmit={(event) => void submit(event)}>
          <Label className="field">
            <span>{t("pact.registrations.fields.origin")}</span>
            <Input
              value={providerOrigin}
              onChange={(event) => setProviderOrigin(event.target.value)}
              placeholder="https://brand.example.com"
              required
            />
          </Label>
          <Label className="field">
            <span>{t("pact.registrations.fields.audience")}</span>
            <Input
              value={audience}
              onChange={(event) => setAudience(event.target.value)}
              placeholder="brand.example.com"
              required
            />
          </Label>
          <Label className="field">
            <span>{t("pact.registrations.fields.notes")}</span>
            <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
          </Label>
          <Label className="field field-checkbox">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            <span>{t("pact.registrations.fields.enabled")}</span>
          </Label>
          {error ? <InlineError message={error} /> : null}
          <div className="button-row">
            <Button variant="outline" type="button" onClick={props.onClose} disabled={busy}>
              {t("common.close")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="spin" size={15} /> : <Plus size={15} />}
              {editing ? t("common.save") : t("pact.registrations.add")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RegistrationTokenDialog(props: { onClose(): void }): ReactNode {
  const t = useTranslate();
  const [audience, setAudience] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<PactRegistrationTokenResponse>("/api/pact/identity/registration-token", {
        audience: audience.trim(),
      });
      setToken(result.token);
    } catch (caught) {
      setError(readErrorMessage(caught, t("pact.identity.tokenFailed")));
    } finally {
      setBusy(false);
    }
  }

  function copyToken(): void {
    if (!token) return;
    void navigator.clipboard?.writeText(token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? props.onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("pact.identity.tokenTitle")}</DialogTitle>
          <DialogDescription>{t("pact.identity.tokenDescription")}</DialogDescription>
        </DialogHeader>
        {token ? (
          <div className="form-grid">
            <Label className="field">
              <span>{t("pact.identity.tokenValue")}</span>
              <Textarea readOnly value={token} rows={5} onFocus={(event) => event.target.select()} />
            </Label>
            <p className="muted-copy">{t("pact.identity.tokenOnce")}</p>
            <div className="button-row">
              <Button variant="outline" type="button" onClick={props.onClose}>
                {t("common.close")}
              </Button>
              <Button type="button" onClick={copyToken}>
                <Copy size={15} />
                {copied ? t("pact.identity.copied") : t("pact.identity.copyToken")}
              </Button>
            </div>
          </div>
        ) : (
          <form className="form-grid" onSubmit={(event) => void submit(event)}>
            <Label className="field">
              <span>{t("pact.identity.tokenAudience")}</span>
              <Input
                value={audience}
                onChange={(event) => setAudience(event.target.value)}
                placeholder="https://provider.example.com/pact/register"
                required
              />
            </Label>
            {error ? <InlineError message={error} /> : null}
            <div className="button-row">
              <Button variant="outline" type="button" onClick={props.onClose} disabled={busy}>
                {t("common.close")}
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? <Loader2 className="spin" size={15} /> : <KeyRound size={15} />}
                {t("pact.identity.mint")}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function readErrorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof Error) return caught.message;
  return fallback;
}
