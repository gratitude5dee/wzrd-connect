import type {
  ConnectionRecord,
  ProviderDefinition,
  RunLog,
  RuntimePolicyState,
  RuntimeTokenCreation,
  RuntimeTokenSummary,
} from "./model";
import type { ReactNode, SubmitEvent } from "react";

import { useTranslate } from "@embra/i18n/react";
import { useClipboard } from "foxact/use-clipboard";
import { Bot, ChevronDown, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  CreateTokenDialog,
  createConnectionGrantDraft,
  emptyPolicyRules,
  PolicyBaseline,
  PolicyLayerDisclosure,
  policyRisk,
  PolicyTester,
  RuntimePolicyDialog,
  RuntimePolicySummary,
  runtimeTokenPolicyBody,
} from "./access-editors";
import { agentActionCount, agentConnectionCount, tokenPolicyRules } from "./agent-access";
import { apiPost, apiPut } from "./api";
import { EmptyRows, Row, RowHeader, RowList } from "./components/row-list";
import { formatDate } from "./model";
import {
  createPolicyEditorDraft,
  policyEditorDraftEquals,
  policyRulesFromEditorDraft,
  validatePolicyEditorDraft,
} from "./policy";
import { FormStatus } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface AgentsPageProps {
  providers: ProviderDefinition[];
  connections: ConnectionRecord[];
  tokens: RuntimeTokenSummary[];
  policy: RuntimePolicyState;
  runs: RunLog[];
  onRefresh(): void;
}

export function AgentsPage(props: AgentsPageProps): ReactNode {
  const t = useTranslate();
  const navigate = useNavigate();
  const { copy, copied } = useClipboard();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [createDraft, setCreateDraft] = useState(() => createPolicyEditorDraft(emptyPolicyRules()));
  const [createConnections, setCreateConnections] = useState(() => createConnectionGrantDraft());
  const [status, setStatus] = useState<string | null>(null);
  const [policyExpanded, setPolicyExpanded] = useState(false);

  const connectionOptions = useMemo(
    () =>
      props.connections.flatMap((connection) => {
        if (!connection.id || connection.virtual || connection.authType === "no_auth") {
          return [];
        }
        const provider = props.providers.find((item) => item.service === connection.service);
        return [
          {
            id: connection.id,
            name: connection.connectionName?.trim() || "default",
            provider: provider?.displayName ?? connection.service,
          },
        ];
      }),
    [props.connections, props.providers],
  );
  const lastActive = useMemo(() => {
    const byToken = new Map<string, string>();
    for (const run of props.runs) {
      if (!run.runtimeTokenId) {
        continue;
      }
      const at = run.completedAt || run.startedAt;
      const previous = byToken.get(run.runtimeTokenId);
      if (!previous || at > previous) {
        byToken.set(run.runtimeTokenId, at);
      }
    }
    return byToken;
  }, [props.runs]);
  async function submitToken(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatus(t("access.creating"));
    try {
      const rules = policyRulesFromEditorDraft(createDraft);
      const result = await apiPost<RuntimeTokenCreation>("/api/runtime-tokens", {
        name,
        ...runtimeTokenPolicyBody(rules, createConnections),
      });
      setStatus(null);
      setCreateOpen(false);
      setName("");
      setCreateDraft(createPolicyEditorDraft(emptyPolicyRules()));
      setCreateConnections(createConnectionGrantDraft());
      props.onRefresh();
      navigate(`/agents/${result.record.id}`, { state: { secret: result.token } });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("access.createFailed"));
    }
  }

  function openCreate(): void {
    setName("");
    setCreateDraft(createPolicyEditorDraft(emptyPolicyRules()));
    setCreateConnections(createConnectionGrantDraft());
    setStatus(null);
    setCreateOpen(true);
  }

  function closeCreate(): void {
    setCreateOpen(false);
    setStatus(null);
  }

  return (
    <section className="detail-panel access-panel">
      <div className="access-section-heading">
        <div>
          <h2>{t("agents.title")}</h2>
          <p>{t("agents.description")}</p>
        </div>
        <Button variant="outline" size="sm" type="button" onClick={openCreate}>
          <Plus size={16} />
          {t("agents.newAgent")}
        </Button>
      </div>

      {!createOpen && status ? <FormStatus message={status} /> : null}

      {props.tokens.length === 0 ? (
        <RowList>
          <EmptyRows action={<Button onClick={openCreate}>{t("agents.newAgent")}</Button>}>
            {t("agents.empty.description")}
          </EmptyRows>
        </RowList>
      ) : (
        <RowList
          header={
            <RowHeader>
              <span className="w-4" />
              <span className="min-w-0 flex-1 truncate">{t("agents.list.name")}</span>
              <span className="agents-cell-id">{t("agents.list.id")}</span>
              <span className="agents-cell-count hidden md:block">{t("agents.list.connections")}</span>
              <span className="agents-cell-count hidden md:block">{t("agents.list.actions")}</span>
              <span className="agents-cell-time hidden md:block">{t("agents.list.lastActive")}</span>
            </RowHeader>
          }
        >
          {props.tokens.map((token) => {
            const conns = agentConnectionCount(token, props.connections, props.providers);
            const actionCount = agentActionCount({
              token,
              rules: tokenPolicyRules(token),
              allowedConnections: token.allowedConnections,
              policy: props.policy,
              providers: props.providers,
              connections: props.connections,
            });
            const active = lastActive.get(token.id) ?? token.lastUsedAt;
            return (
              <Row
                key={token.id}
                to={`/agents/${token.id}`}
                icon={<Bot size={16} className="shrink-0" />}
                title={token.name}
                cells={
                  <>
                    <span className="agents-cell-id">{token.id.slice(0, 8)}</span>
                    <span className="agents-cell-count hidden md:block">
                      {t("agents.list.connectionsCount", conns)}
                    </span>
                    <span className="agents-cell-count hidden md:block">
                      {t("agents.list.actionsCount", actionCount)}
                    </span>
                    <span className="agents-cell-time hidden md:block">{active ? formatDate(active) : "—"}</span>
                  </>
                }
              />
            );
          })}
        </RowList>
      )}

      <details
        className="access-section-disclosure agents-defaults"
        open={policyExpanded}
        onToggle={(event) => setPolicyExpanded(event.currentTarget.open)}
      >
        <summary className="access-section-heading">
          <div>
            <h2>{t("agents.defaults.title")}</h2>
            <p>{t("agents.defaults.description")}</p>
          </div>
          <ChevronDown size={17} />
        </summary>
        <div className="access-section-content">
          <PolicyBaseline policy={props.policy} providers={props.providers} />
          <PolicyTester policy={props.policy} providers={props.providers} tokens={props.tokens} />
          <div className="access-settings-list">
            <PolicyLayerDisclosure rules={props.policy.deployment} />
            <RuntimeDefaultsEditor policy={props.policy} providers={props.providers} onRefresh={props.onRefresh} />
          </div>
        </div>
      </details>

      {createOpen ? (
        <CreateTokenDialog
          name={name}
          created={null}
          status={status}
          copied={copied}
          draft={createDraft}
          connections={createConnections}
          connectionOptions={connectionOptions}
          providers={props.providers}
          onNameChange={setName}
          onDraftChange={setCreateDraft}
          onConnectionsChange={setCreateConnections}
          onSubmit={submitToken}
          onCopy={(token) => void copy(token)}
          onClose={closeCreate}
        />
      ) : null}
    </section>
  );
}

/** The runtime-layer editor the old access page hosted: summary row + full dialog. */
function RuntimeDefaultsEditor(props: {
  policy: RuntimePolicyState;
  providers: ProviderDefinition[];
  onRefresh(): void;
}): ReactNode {
  const t = useTranslate();
  const [policy, setPolicy] = useState(props.policy);
  const [draft, setDraft] = useState(() => createPolicyEditorDraft(props.policy.runtime));
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const previousPolicy = useRef(props.policy);
  const savedDraft = useMemo(() => createPolicyEditorDraft(policy.runtime), [policy.runtime]);
  const dirty = !policyEditorDraftEquals(draft, savedDraft);
  const rules = useMemo(() => policyRulesFromEditorDraft(draft), [draft]);
  const draftState: RuntimePolicyState = useMemo(() => ({ ...policy, runtime: rules }), [policy, rules]);
  const issues = validatePolicyEditorDraft(draft, true);
  const risk = useMemo(
    () => (editing ? policyRisk(draftState, props.providers) : null),
    [draftState, props.providers, editing],
  );

  useEffect(() => {
    if (props.policy === previousPolicy.current) {
      return;
    }
    previousPolicy.current = props.policy;
    if (!editing) {
      setPolicy(props.policy);
      setDraft(createPolicyEditorDraft(props.policy.runtime));
    }
  }, [props.policy, editing]);

  async function persist(): Promise<void> {
    setSaving(true);
    setStatus(t("access.policy.saving"));
    try {
      const updated = await apiPut<RuntimePolicyState>("/api/runtime-policy", rules);
      setPolicy(updated);
      setDraft(createPolicyEditorDraft(updated.runtime));
      setStatus(t("access.policy.saved"));
      setEditing(false);
      props.onRefresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("access.policy.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  function requestSave(): void {
    if (issues.length > 0 || !dirty) {
      return;
    }
    if (risk) {
      setConfirmSave(true);
      return;
    }
    void persist();
  }

  function discard(): void {
    setConfirmSave(false);
    setPolicy(props.policy);
    setDraft(createPolicyEditorDraft(props.policy.runtime));
    setStatus(null);
    setEditing(false);
  }

  return (
    <>
      <RuntimePolicySummary policy={policy} onEdit={() => setEditing(true)} />
      {!editing && status ? <FormStatus message={status} /> : null}
      {editing ? (
        <RuntimePolicyDialog
          draft={draft}
          draftState={draftState}
          providers={props.providers}
          dirty={dirty}
          risk={risk}
          saving={saving}
          status={status}
          onDraftChange={setDraft}
          onDiscard={discard}
          onSave={requestSave}
        />
      ) : null}
      <Dialog open={confirmSave} onOpenChange={setConfirmSave}>
        <DialogContent className="max-w-[min(480px,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle>{t("access.policy.confirm.title")}</DialogTitle>
            <DialogDescription>{t(`access.policy.confirm.${risk ?? "actions"}`)}</DialogDescription>
          </DialogHeader>
          <div className="button-row">
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmSave(false);
                void persist();
              }}
            >
              {t("access.policy.confirm.save")}
            </Button>
            <Button variant="outline" onClick={() => setConfirmSave(false)}>
              {t("access.policy.confirm.keepEditing")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
