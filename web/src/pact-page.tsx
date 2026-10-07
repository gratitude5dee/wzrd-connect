import type {
  ConnectionRecord,
  PactBrandConnectResponse,
  PactCardPreview,
  PactCardPreviewResponse,
  PactIdentity,
  PactIdentityResponse,
  PactRegistration,
  PactRegistrationList,
  PactRegistrationResponse,
  PactRegistrationTokenResponse,
} from "./model";
import type { ReactNode, SubmitEvent } from "react";

import { useTranslate } from "@embra/i18n/react";
import { Copy, KeyRound, Loader2, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
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
  const [brands, setBrands] = useState<ConnectionRecord[]>([]);
  const [connectOpen, setConnectOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<PactRegistration | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [copiedKid, setCopiedKid] = useState(false);

  async function load(): Promise<void> {
    try {
      const [identityResult, registrationList, connectionList] = await Promise.all([
        apiGet<PactIdentityResponse>("/api/pact/identity"),
        apiGet<PactRegistrationList>("/api/pact/registrations"),
        apiGet<ConnectionRecord[]>("/api/connections"),
      ]);
      setIdentity(identityResult.identity);
      setRegistrations(registrationList.items);
      setBrands(connectionList.filter((connection) => connection.service === "pact"));
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

      <section className="example-card">
        <div className="tab-row">
          <h3>{t("pact.brands.heading")}</h3>
          <Button size="sm" onClick={() => setConnectOpen(true)}>
            <Plus size={14} />
            {t("pact.brands.connect")}
          </Button>
        </div>
        {brands.length === 0 ? (
          <EmptyState title={t("pact.brands.empty")} description={t("pact.brands.emptyHint")} />
        ) : (
          <div className="table-wrap">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("pact.brands.columns.alias")}</TableHead>
                  <TableHead>{t("pact.brands.columns.brand")}</TableHead>
                  <TableHead>{t("pact.brands.columns.interface")}</TableHead>
                  <TableHead>{t("pact.brands.columns.mode")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {brands.map((brand) => (
                  <TableRow key={brand.id ?? brand.connectionName}>
                    <TableCell>
                      <code>{brand.connectionName}</code>
                    </TableCell>
                    <TableCell>
                      <code>{brand.pact?.brandDomain ?? brand.pact?.providerOrigin}</code>
                    </TableCell>
                    <TableCell>
                      <code>{brand.pact?.interfaceUrl}</code>
                    </TableCell>
                    <TableCell>{brand.identityOnly ? <Badge>{t("pact.brands.identityOnly")}</Badge> : null}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {connectOpen ? (
        <ConnectBrandDialog
          onClose={() => setConnectOpen(false)}
          onConnected={() => {
            setConnectOpen(false);
            void load();
          }}
        />
      ) : null}
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

interface ConnectBrandDialogProps {
  onClose(): void;
  onConnected(): void;
}

function ConnectBrandDialog(props: ConnectBrandDialogProps): ReactNode {
  const t = useTranslate();
  const [cardUrl, setCardUrl] = useState("");
  const [preview, setPreview] = useState<PactCardPreview | null>(null);
  const [connectionName, setConnectionName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"preview" | "connect" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadPreview(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy("preview");
    setError(null);
    setPreview(null);
    try {
      const result = await apiPost<PactCardPreviewResponse>("/api/pact/brands/preview", {
        agentCardUrl: cardUrl.trim(),
      });
      setPreview(result.preview);
      if (!connectionName) setConnectionName(suggestAlias(result.preview.name));
      setSelectedScopes(new Set());
    } catch (caught) {
      setError(readErrorMessage(caught, t("pact.brands.previewFailed")));
    } finally {
      setBusy(null);
    }
  }

  function toggleScope(scopeId: string): void {
    const next = new Set(selectedScopes);
    if (next.has(scopeId)) next.delete(scopeId);
    else next.add(scopeId);
    setSelectedScopes(next);
  }

  async function connect(): Promise<void> {
    setBusy("connect");
    setError(null);
    try {
      await apiPost<PactBrandConnectResponse>("/v1/connections/pact/connect", {
        connectionName: connectionName.trim(),
        agentCardUrl: cardUrl.trim(),
        scopes: selectedScopes.size ? [...selectedScopes] : undefined,
      });
      props.onConnected();
    } catch (caught) {
      setError(readErrorMessage(caught, t("pact.brands.connectFailed")));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? props.onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("pact.brands.connectTitle")}</DialogTitle>
          <DialogDescription>{t("pact.brands.connectDescription")}</DialogDescription>
        </DialogHeader>
        <form className="form-grid" onSubmit={(event) => void loadPreview(event)}>
          <Label className="field">
            <span>{t("pact.brands.fields.cardUrl")}</span>
            <Input
              value={cardUrl}
              onChange={(event) => setCardUrl(event.target.value)}
              placeholder="https://brand.example.com"
              required
            />
          </Label>
          <div className="button-row">
            <Button type="submit" disabled={busy !== null || !cardUrl.trim()}>
              {busy === "preview" ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
              {t("pact.brands.preview")}
            </Button>
          </div>
        </form>
        {preview ? (
          <div className="form-grid">
            <dl className="approval-detail-fields">
              <dt>{t("pact.brands.previewFields.name")}</dt>
              <dd>{preview.name}</dd>
              <dt>{t("pact.brands.previewFields.provider")}</dt>
              <dd>
                <code>{preview.providerOrigin}</code>
              </dd>
              <dt>{t("pact.brands.previewFields.interface")}</dt>
              <dd>
                <code>{preview.interfaceUrl}</code>
              </dd>
              <dt>{t("pact.brands.previewFields.registration")}</dt>
              <dd>
                {preview.registration
                  ? preview.registration.enabled
                    ? t("pact.brands.registered")
                    : t("pact.brands.registrationDisabled")
                  : t("pact.brands.notRegistered")}
              </dd>
            </dl>
            <Label className="field">
              <span>{t("pact.brands.fields.alias")}</span>
              <Input
                value={connectionName}
                onChange={(event) => setConnectionName(event.target.value)}
                placeholder="acme-brand"
                required
              />
            </Label>
            {preview.scopes.length ? (
              <div className="field">
                <span>{t("pact.brands.fields.scopes")}</span>
                {preview.scopes.map((scope) => (
                  <label key={scope.id} className="field field-checkbox">
                    <input
                      type="checkbox"
                      checked={selectedScopes.has(scope.id)}
                      onChange={() => toggleScope(scope.id)}
                    />
                    <code>{scope.id}</code>
                    <span className="muted-copy">{scope.description}</span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {error ? <InlineError message={error} /> : null}
        <div className="button-row">
          <Button variant="outline" type="button" onClick={props.onClose} disabled={busy !== null}>
            {t("common.close")}
          </Button>
          <Button
            type="button"
            disabled={busy !== null || !preview || !connectionName.trim()}
            onClick={() => void connect()}
          >
            {busy === "connect" ? <Loader2 className="spin" size={15} /> : <Plus size={15} />}
            {t("pact.brands.connect")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Alias suggestions follow the runtime `connectionName` validator. */
function suggestAlias(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .replace(/-+$/u, "")
    .slice(0, 64);
}

function readErrorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof Error) return caught.message;
  return fallback;
}
