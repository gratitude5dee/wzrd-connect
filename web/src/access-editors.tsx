import type {
  ApprovalOperationType,
  ConnectionRecord,
  PolicyRules,
  ProviderDefinition,
  RuntimePolicyState,
  RuntimeTokenCreation,
  RuntimeTokenSummary,
} from "./model";
import type { PolicyEditorDraft, PolicyEvaluation, PolicyResource } from "./policy";
import type { ReactNode, SubmitEvent } from "react";

import { useTranslate } from "@embra/i18n/react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleCheck,
  CircleX,
  Copy,
  KeyRound,
  Loader2,
  Pencil,
  Play,
  RotateCcw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import { formatDate } from "./model";
import {
  countAllowedActions,
  countAllowedProxies,
  evaluatePolicy,
  filterPolicyRuleCandidates,
  parsePolicyLines,
  policyLayers,
  policyRuleCandidates,
  validatePolicyEditorDraft,
} from "./policy";
import { PolicyEditor } from "./policy-editor";
import { PolicySuggestionInput } from "./policy-suggestion-input";
import { Badge, FormStatus } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export interface ConnectionGrantDraft {
  mode: "unrestricted" | "restricted";
  ids: string[];
}

export interface ConnectionGrantOption {
  id: string;
  name: string;
  provider: string;
}

export interface CreateTokenDialogProps {
  name: string;
  created: RuntimeTokenCreation | null;
  status: string | null;
  copied: boolean;
  draft: PolicyEditorDraft;
  connections: ConnectionGrantDraft;
  connectionOptions: ConnectionGrantOption[];
  providers: ProviderDefinition[];
  onNameChange(name: string): void;
  onDraftChange(draft: PolicyEditorDraft): void;
  onConnectionsChange(draft: ConnectionGrantDraft): void;
  onSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void>;
  onCopy(token: string): void;
  onClose(): void;
}

export interface PolicyDraft {
  allowedActions: string;
  blockedActions: string;
  allowedProxies: string;
  blockedProxies: string;
}

export function createTokenDialogMode(created: RuntimeTokenCreation | null): "form" | "created" {
  return created ? "created" : "form";
}

export function PolicyBaseline(props: { policy: RuntimePolicyState; providers: ProviderDefinition[] }): ReactNode {
  const t = useTranslate();
  const titleId = useId();
  const { actions, proxies } = useMemo(() => {
    const layers = policyLayers(props.policy);
    return {
      actions: countAllowedActions(props.providers, layers),
      proxies: countAllowedProxies(props.providers, layers),
    };
  }, [props.policy, props.providers]);
  const deploymentRules = configuredRuleCount(props.policy.deployment);
  const runtimeRules = configuredRuleCount(props.policy.runtime);
  const actionsBlocked = actions.total > 0 && actions.allowed === 0;
  const proxiesBlocked = proxies.total > 0 && proxies.allowed === 0;
  const risk =
    actionsBlocked && proxiesBlocked ? "all" : actionsBlocked ? "actions" : proxiesBlocked ? "proxies" : null;

  return (
    <section className="policy-baseline" aria-labelledby={titleId}>
      <div className="policy-section-title">
        <h3 id={titleId}>{t("access.policy.baseline.title")}</h3>
        <Badge tone={risk ? "error" : "success"}>
          {risk ? <AlertTriangle size={13} /> : <CircleCheck size={13} />}
          {t(risk ? `access.policy.baseline.${risk}Blocked` : "access.policy.baseline.healthy")}
        </Badge>
      </div>
      <div className="policy-baseline-grid">
        <div>
          <span>{t("access.policy.baseline.actions")}</span>
          <strong>{t("access.policy.baseline.allowedCount", actions)}</strong>
          <small>{t("access.policy.baseline.catalogHint")}</small>
        </div>
        <div>
          <span>{t("access.policy.baseline.proxies")}</span>
          <strong>{t("access.policy.baseline.allowedCount", proxies)}</strong>
          <small>{t("access.policy.baseline.providersHint")}</small>
        </div>
        <div>
          <span>{t("access.policy.baseline.layers")}</span>
          <strong>
            {t("access.policy.baseline.layerCount", { deployment: deploymentRules, runtime: runtimeRules })}
          </strong>
          <small>{t("access.policy.baseline.blockPriority")}</small>
        </div>
      </div>
    </section>
  );
}

export function PolicyTester(props: {
  policy: RuntimePolicyState;
  providers: ProviderDefinition[];
  tokens: RuntimeTokenSummary[];
  compact?: boolean;
}): ReactNode {
  const t = useTranslate();
  const [resource, setResource] = useState<PolicyResource>("action");
  const [tokenId, setTokenId] = useState("none");
  const candidates = useMemo(
    () =>
      policyRuleCandidates(props.providers, resource).filter(
        (candidate) => candidate !== "*" && !candidate.endsWith(".*"),
      ),
    [props.providers, resource],
  );
  const [input, setInput] = useState("");
  const [testedValue, setTestedValue] = useState("");
  const suggestions = useMemo(
    () => (input.trim() ? filterPolicyRuleCandidates(candidates, input, 6) : []),
    [candidates, input],
  );
  const token = props.tokens.find((item) => item.id === tokenId);
  const layers = policyLayers(props.policy, token);
  const result = testedValue ? evaluatePolicy(testedValue, resource, layers) : null;
  const listId = `policy-tester-${props.compact ? "compact" : "default"}-${resource}`;

  function changeResource(next: PolicyResource): void {
    setResource(next);
    setInput("");
    setTestedValue("");
  }

  return (
    <section className={props.compact ? "policy-tester compact" : "policy-tester"}>
      <div className="policy-section-title">
        <h3>{t("access.policy.tester.title")}</h3>
        {!props.compact ? <p>{t("access.policy.tester.description")}</p> : null}
      </div>
      <form
        className="policy-tester-form"
        onSubmit={(event) => {
          event.preventDefault();
          setTestedValue(input.trim());
        }}
      >
        <ToggleGroup
          className="policy-resource-control bg-muted p-[3px]"
          type="single"
          value={resource}
          spacing={0}
          aria-label={t("access.policy.tester.resourceLabel")}
          onValueChange={(value) => (value ? changeResource(value as PolicyResource) : undefined)}
        >
          <ToggleGroupItem
            value="action"
            className="h-[30px] rounded-md px-3 text-sm data-[state=on]:bg-background data-[state=on]:shadow-console-sm"
          >
            {t("access.policy.tester.action")}
          </ToggleGroupItem>
          <ToggleGroupItem
            value="proxy"
            className="h-[30px] rounded-md px-3 text-sm data-[state=on]:bg-background data-[state=on]:shadow-console-sm"
          >
            {t("access.policy.tester.proxy")}
          </ToggleGroupItem>
        </ToggleGroup>
        {props.tokens.length > 0 ? (
          <Select value={tokenId} onValueChange={setTokenId}>
            <SelectTrigger className="policy-token-select-trigger" aria-label={t("access.policy.tester.tokenLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="policy-token-select-content" position="popper" align="start" sideOffset={4}>
              <SelectGroup>
                <SelectItem value="none">{t("access.policy.tester.noToken")}</SelectItem>
                {props.tokens.map((item) => (
                  <SelectItem value={item.id} key={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : null}
        <Label className="sr-only" htmlFor={`${listId}-input`}>
          {t("access.policy.tester.inputLabel")}
        </Label>
        <PolicySuggestionInput
          id={`${listId}-input`}
          value={input}
          suggestions={suggestions}
          placeholder={t(`access.policy.tester.${resource}Placeholder`)}
          onChange={setInput}
        />
        <Button type="submit" disabled={!input.trim()}>
          <Play size={15} />
          {t("access.policy.tester.test")}
        </Button>
      </form>
      {result ? <PolicyDecisionTrace value={testedValue} result={result} /> : null}
    </section>
  );
}

export function PolicyDecisionTrace(props: { value: string; result: PolicyEvaluation }): ReactNode {
  const t = useTranslate();
  return (
    <details className="policy-decision-trace">
      <summary>
        <Badge tone={props.result.allowed ? "success" : "error"}>
          {props.result.allowed ? <CircleCheck size={13} /> : <CircleX size={13} />}
          {t(props.result.allowed ? "access.policy.tester.allowed" : "access.policy.tester.blocked")}
        </Badge>
        <code>{props.value}</code>
        <span>{t("access.policy.tester.trace")}</span>
        <ChevronDown size={15} />
      </summary>
      <ol>
        {props.result.trace.map((check) => (
          <li key={check.source}>
            <strong>{t(`access.policy.sources.${check.source}`)}</strong>
            <span>{t(`access.policy.outcomes.${check.outcome}`)}</span>
            {check.rule ? <code>{check.rule}</code> : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function PolicyLayerDisclosure(props: { rules: PolicyRules }): ReactNode {
  const t = useTranslate();
  return (
    <details className="policy-layer-disclosure">
      <summary>
        <ShieldCheck size={16} />
        <div className="access-setting-copy">
          <strong>{t("access.policy.deploymentSummary.title")}</strong>
          <span>{policyLayerSummary(props.rules, t)}</span>
        </div>
        <ChevronDown size={15} />
      </summary>
      <PolicyRuleReadout rules={props.rules} />
    </details>
  );
}

export function RuntimePolicySummary(props: { policy: RuntimePolicyState; onEdit(): void }): ReactNode {
  const t = useTranslate();
  return (
    <section className="runtime-policy-summary">
      <SlidersHorizontal size={16} />
      <div className="access-setting-copy">
        <strong>{t("access.policy.runtimeSummary.title")}</strong>
        <span>
          {policyLayerSummary(props.policy.runtime, t)}
          {props.policy.updatedAt
            ? ` · ${t("access.policy.runtimeSummary.updated", { date: formatDate(props.policy.updatedAt) })}`
            : ""}
        </span>
      </div>
      <Button variant="outline" size="sm" onClick={props.onEdit}>
        <Pencil size={15} />
        {t("access.policy.runtimeSummary.edit")}
      </Button>
    </section>
  );
}

export interface RuntimePolicyDialogProps {
  draft: PolicyEditorDraft;
  draftState: RuntimePolicyState;
  providers: ProviderDefinition[];
  dirty: boolean;
  risk: "actions" | "proxies" | "all" | null;
  saving: boolean;
  status: string | null;
  onDraftChange(draft: PolicyEditorDraft): void;
  onDiscard(): void;
  onSave(): void;
}

export function RuntimePolicyDialog(props: RuntimePolicyDialogProps): ReactNode {
  const t = useTranslate();
  return (
    <Dialog open onOpenChange={(open) => (!open ? props.onDiscard() : undefined)}>
      <DialogContent className="runtime-policy-dialog max-h-[calc(100svh-2rem)] max-w-[min(1080px,calc(100vw-2rem))] overflow-y-auto sm:max-w-[min(1080px,calc(100vw-2rem))]">
        <div className="runtime-policy-dialog-heading">
          <DialogHeader>
            <DialogTitle>{t("access.policy.editor.title")}</DialogTitle>
            <DialogDescription>{t("access.policy.editor.description")}</DialogDescription>
          </DialogHeader>
          <Badge tone={props.dirty ? "warning" : undefined}>
            {t(props.dirty ? "access.policy.editor.unsaved" : "access.policy.editor.noChanges")}
          </Badge>
        </div>
        <RuntimePolicyEditor {...props} />
      </DialogContent>
    </Dialog>
  );
}

export function RuntimePolicyEditor(props: RuntimePolicyDialogProps): ReactNode {
  const t = useTranslate();
  const issues = validatePolicyEditorDraft(props.draft, true);

  return (
    <section className="runtime-policy-editor">
      <div className="runtime-policy-editor-grid">
        <PolicyEditor
          draft={props.draft}
          providers={props.providers}
          includeProxies
          approvalScope="layer"
          onChange={props.onDraftChange}
        />
        <aside className="policy-impact-panel" id="runtime-policy-impact">
          <h3>{t("access.policy.impact.title")}</h3>
          <p>{t("access.policy.impact.description")}</p>
          <PolicyBaseline policy={props.draftState} providers={props.providers} />
          <PolicyTester policy={props.draftState} providers={props.providers} tokens={[]} compact />
          {props.risk ? (
            <div className="policy-risk-warning" role="alert">
              <AlertTriangle size={16} />
              <span>{t(`access.policy.impact.${props.risk}Blocked`)}</span>
            </div>
          ) : null}
        </aside>
      </div>
      <div className="runtime-policy-actions">
        <span>{t(props.dirty ? "access.policy.editor.unsaved" : "access.policy.editor.noChanges")}</span>
        <div className="button-row">
          <Button type="button" variant="outline" onClick={props.onDiscard}>
            <RotateCcw size={15} />
            {t("access.policy.editor.discard")}
          </Button>
          <Button type="button" disabled={!props.dirty || issues.length > 0 || props.saving} onClick={props.onSave}>
            {props.saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
            {t("access.policy.save")}
          </Button>
        </div>
      </div>
      {props.status ? <FormStatus message={props.status} /> : null}
    </section>
  );
}

function PolicyRuleReadout(props: { rules: PolicyRules }): ReactNode {
  const t = useTranslate();
  const fields = [
    ["allowedActions", t("access.policy.allowedActions")],
    ["blockedActions", t("access.policy.blockedActions")],
    ["allowedProxies", t("access.policy.allowedProxies")],
    ["blockedProxies", t("access.policy.blockedProxies")],
    ["requireApprovalOperations", t("access.policy.requireApprovalOperations")],
    ["approvalRequiredActions", t("access.policy.approvalRequiredActions")],
    ["approvalExemptActions", t("access.policy.approvalExemptActions")],
  ] as const;
  return (
    <div className="policy-rule-readout">
      {fields.map(([field, label]) => {
        const rules = props.rules[field] ?? [];
        return (
          <div key={field}>
            <strong>{label}</strong>
            {rules.length > 0 ? (
              <div>
                {rules.map((rule) => (
                  <code key={rule}>{rule}</code>
                ))}
              </div>
            ) : (
              <span>{t("access.policy.deploymentSummary.none")}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function CreateTokenDialog(props: CreateTokenDialogProps): ReactNode {
  const t = useTranslate();
  const mode = createTokenDialogMode(props.created);
  const created = mode === "created" ? props.created : null;
  const issues = validatePolicyEditorDraft(props.draft, true);
  const connectionIssue = connectionGrantIssue(props.connections);

  return (
    <Dialog open onOpenChange={(open) => (!open ? props.onClose() : undefined)}>
      <DialogContent
        className="token-dialog policy-token-dialog max-w-[min(760px,calc(100vw-2rem))] gap-0 overflow-hidden p-0 sm:max-w-[min(760px,calc(100vw-2rem))]"
        showCloseButton={false}
      >
        <DialogHeader className="token-dialog-header">
          <div>
            <DialogTitle>{mode === "created" ? t("access.newToken") : t("access.createToken")}</DialogTitle>
            <DialogDescription>
              {mode === "created" ? t("access.tokenShownOnce") : t("access.createTokenDescription")}
            </DialogDescription>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={props.onClose} aria-label={t("access.closeCreateToken")}>
            <X size={16} />
          </Button>
        </DialogHeader>
        <div className="token-dialog-body">
          {created ? (
            <>
              <section className="example-card token-result">
                <div className="tab-row">
                  <strong>{t("access.newToken")}</strong>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => props.onCopy(created.token)}
                    aria-label={props.copied ? t("access.copiedRuntimeToken") : t("access.copyRuntimeToken")}
                  >
                    {props.copied ? <Check size={15} /> : <Copy size={15} />}
                    {props.copied ? t("access.copiedToken") : t("access.copyToken")}
                  </Button>
                </div>
                <pre>{created.token}</pre>
              </section>
              <FormStatus message={t("access.tokenShownOnce")} />
              <div className="button-row">
                <Button variant="outline" type="button" onClick={props.onClose}>
                  {t("common.close")}
                </Button>
              </div>
            </>
          ) : (
            <form className="token-dialog-form" onSubmit={(event) => void props.onSubmit(event)}>
              <Label className="field">
                <span>{t("access.name")}</span>
                <Input
                  value={props.name}
                  onChange={(event) => props.onNameChange(event.target.value)}
                  placeholder={t("access.namePlaceholder")}
                />
              </Label>
              <PolicyEditor
                draft={props.draft}
                providers={props.providers}
                includeProxies
                proxyAccess="grant"
                approvalScope="token"
                connectionEditor={
                  <ConnectionGrantEditor
                    draft={props.connections}
                    options={props.connectionOptions}
                    onChange={props.onConnectionsChange}
                  />
                }
                connectionInvalid={connectionIssue != null}
                onChange={props.onDraftChange}
              />
              {props.status ? <FormStatus message={props.status} /> : null}
              <div className="token-dialog-actions">
                <div className="button-row">
                  <Button variant="outline" type="button" onClick={props.onClose}>
                    {t("common.close")}
                  </Button>
                  <Button type="submit" disabled={!props.name.trim() || issues.length > 0 || connectionIssue != null}>
                    <KeyRound size={16} />
                    {t("access.createToken")}
                  </Button>
                </div>
              </div>
            </form>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface EditTokenPolicyDialogProps {
  token: RuntimeTokenSummary;
  draft: PolicyEditorDraft;
  connections: ConnectionGrantDraft;
  connectionOptions: ConnectionGrantOption[];
  providers: ProviderDefinition[];
  status: string | null;
  onDraftChange(draft: PolicyEditorDraft): void;
  onConnectionsChange(draft: ConnectionGrantDraft): void;
  onSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void>;
  onClose(): void;
}

export function EditTokenPolicyDialog(props: EditTokenPolicyDialogProps): ReactNode {
  const t = useTranslate();
  const issues = validatePolicyEditorDraft(props.draft, true);
  const connectionIssue = connectionGrantIssue(props.connections);
  return (
    <Dialog open onOpenChange={(open) => (!open ? props.onClose() : undefined)}>
      <DialogContent
        className="token-dialog policy-token-dialog max-w-[min(760px,calc(100vw-2rem))] gap-0 overflow-hidden p-0 sm:max-w-[min(760px,calc(100vw-2rem))]"
        showCloseButton={false}
      >
        <DialogHeader className="token-dialog-header">
          <div>
            <DialogTitle>{t("access.policy.editToken")}</DialogTitle>
            <DialogDescription>{props.token.name}</DialogDescription>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={props.onClose} aria-label={t("common.close")}>
            <X size={16} />
          </Button>
        </DialogHeader>
        <div className="token-dialog-body">
          <form className="token-dialog-form" onSubmit={(event) => void props.onSubmit(event)}>
            <PolicyEditor
              draft={props.draft}
              providers={props.providers}
              includeProxies
              proxyAccess="grant"
              approvalScope="token"
              connectionEditor={
                <ConnectionGrantEditor
                  draft={props.connections}
                  options={props.connectionOptions}
                  onChange={props.onConnectionsChange}
                />
              }
              connectionInvalid={connectionIssue != null}
              onChange={props.onDraftChange}
            />
            {props.status ? <FormStatus message={props.status} /> : null}
            <div className="token-dialog-actions">
              <div className="button-row">
                <Button variant="outline" type="button" onClick={props.onClose}>
                  {t("common.close")}
                </Button>
                <Button type="submit" disabled={issues.length > 0 || connectionIssue != null}>
                  <Save size={16} />
                  {t("access.policy.save")}
                </Button>
              </div>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function policyDraftFromRules(rules: PolicyRules): PolicyDraft {
  return {
    allowedActions: rules.allowedActions.join("\n"),
    blockedActions: rules.blockedActions.join("\n"),
    allowedProxies: rules.allowedProxies.join("\n"),
    blockedProxies: rules.blockedProxies.join("\n"),
  };
}

export function policyRulesFromDraft(draft: PolicyDraft): PolicyRules {
  return {
    allowedActions: parsePolicyLines(draft.allowedActions),
    blockedActions: parsePolicyLines(draft.blockedActions),
    allowedProxies: parsePolicyLines(draft.allowedProxies),
    blockedProxies: parsePolicyLines(draft.blockedProxies),
  };
}

export function policyLayerSummary(rules: PolicyRules, t: NonNullable<ReturnType<typeof useTranslate>>): string {
  const action = resourcePolicySummary(rules.allowedActions, rules.blockedActions, t);
  const proxy = resourcePolicySummary(rules.allowedProxies, rules.blockedProxies, t);
  return t("access.policy.layerSummary", { action, proxy });
}

export function resourcePolicySummary(
  allowed: string[],
  blocked: string[],
  t: NonNullable<ReturnType<typeof useTranslate>>,
): string {
  const allowSummary =
    allowed.length === 0
      ? t("access.policy.summary.unrestricted")
      : t("access.policy.summary.restricted", { count: allowed.length });
  return blocked.length === 0
    ? allowSummary
    : t("access.policy.summary.withBlocked", { allow: allowSummary, count: blocked.length });
}

export function configuredRuleCount(rules: PolicyRules): number {
  return Object.values(rules).reduce((count, values) => count + (values?.length ?? 0), 0);
}

export function policyRisk(
  policy: RuntimePolicyState,
  providers: ProviderDefinition[],
): "actions" | "proxies" | "all" | null {
  const layers = policyLayers(policy);
  const actions = countAllowedActions(providers, layers);
  const proxies = countAllowedProxies(providers, layers);
  const actionsBlocked = actions.total > 0 && actions.allowed === 0;
  const proxiesBlocked = proxies.total > 0 && proxies.allowed === 0;
  return actionsBlocked && proxiesBlocked ? "all" : actionsBlocked ? "actions" : proxiesBlocked ? "proxies" : null;
}

export function emptyPolicyRules(): PolicyRules {
  return { allowedActions: [], blockedActions: [], allowedProxies: [], blockedProxies: [] };
}

const defaultConnectionName = "default";
const connectionListMaxItems = 128;

export function createConnectionGrantDraft(ids: string[] = []): ConnectionGrantDraft {
  return {
    mode: ids.length > 0 ? "restricted" : "unrestricted",
    ids: [...ids],
  };
}

export function allowedConnectionsFromDraft(draft: ConnectionGrantDraft): string[] {
  return draft.mode === "restricted" ? [...draft.ids] : [];
}

export function runtimeTokenPolicyBody(
  rules: Pick<
    PolicyRules,
    | "allowedActions"
    | "blockedActions"
    | "allowedProxies"
    | "allowedTriggers"
    | "requireApprovalOperations"
    | "approvalRequiredActions"
  >,
  connections: ConnectionGrantDraft,
): {
  allowedActions: string[];
  blockedActions: string[];
  allowedProxies: string[];
  allowedConnections: string[];
  allowedTriggers: string[];
  requireApprovalOperations: ApprovalOperationType[];
  approvalRequiredActions: string[];
} {
  return {
    allowedActions: rules.allowedActions,
    blockedActions: rules.blockedActions,
    allowedProxies: rules.allowedProxies,
    allowedConnections: allowedConnectionsFromDraft(connections),
    allowedTriggers: rules.allowedTriggers ?? [],
    requireApprovalOperations: rules.requireApprovalOperations ?? [],
    approvalRequiredActions: rules.approvalRequiredActions ?? [],
  };
}

export function connectionGrantOptions(
  connections: ConnectionRecord[],
  providers: ProviderDefinition[] = [],
): ConnectionGrantOption[] {
  const providerNames = new Map(providers.map((provider) => [provider.service, provider.displayName]));
  return connections.flatMap((connection) => {
    if (!connection.id || connection.virtual || connection.authType === "no_auth") {
      return [];
    }
    return [
      {
        id: connection.id,
        name: connection.connectionName?.trim() || defaultConnectionName,
        provider: providerNames.get(connection.service) ?? connection.service,
      },
    ];
  });
}

export function connectionGrantIssue(draft: ConnectionGrantDraft): "required" | "too_many" | undefined {
  if (draft.mode !== "restricted") {
    return undefined;
  }
  return draft.ids.length === 0 ? "required" : draft.ids.length > connectionListMaxItems ? "too_many" : undefined;
}

export interface ConnectionGrantEditorProps {
  draft: ConnectionGrantDraft;
  options: ConnectionGrantOption[];
  onChange(draft: ConnectionGrantDraft): void;
}

export function ConnectionGrantEditor(props: ConnectionGrantEditorProps): ReactNode {
  const t = useTranslate();
  const listId = useId();
  const options: ConnectionGrantOption[] = [
    ...props.options,
    ...props.draft.ids
      .filter((id) => !props.options.some((option) => option.id === id))
      .map((id) => ({ id, name: id, provider: t("access.policy.editor.unknownRule") })),
  ];
  const issue = connectionGrantIssue(props.draft);

  function setMode(mode: ConnectionGrantDraft["mode"]): void {
    props.onChange({
      mode,
      ids: mode === "unrestricted" ? [] : props.draft.ids,
    });
  }

  return (
    <div className="policy-resource-editor">
      <fieldset className="policy-allow-mode">
        <legend>{t("access.policy.editor.connectionsTitle")}</legend>
        <label>
          <input
            type="radio"
            name={`${listId}-connection-mode`}
            value="unrestricted"
            checked={props.draft.mode === "unrestricted"}
            onChange={() => setMode("unrestricted")}
          />
          <span>
            <strong>{t("access.policy.editor.unrestricted")}</strong>
            <small>{t("access.policy.editor.connectionsUnrestrictedHint")}</small>
          </span>
        </label>
        <label>
          <input
            type="radio"
            name={`${listId}-connection-mode`}
            value="restricted"
            checked={props.draft.mode === "restricted"}
            onChange={() => setMode("restricted")}
          />
          <span>
            <strong>{t("access.policy.editor.restricted")}</strong>
            <small>{t("access.policy.editor.connectionsRestrictedHint")}</small>
          </span>
        </label>
      </fieldset>
      {props.draft.mode === "restricted" ? (
        <section className="policy-rule-section">
          <div className="policy-rule-heading">
            <div>
              <h4>{t("access.policy.editor.connectionsList")}</h4>
            </div>
            <span>{t("access.policy.editor.connectionCount", { count: props.draft.ids.length })}</span>
          </div>
          <p>{t("access.policy.editor.connectionsDefaultHint")}</p>
          {options.length > 0 ? (
            <div className="connection-grant-list">
              {options.map((option, index) => {
                const checked = props.draft.ids.includes(option.id);
                return (
                  <label className="connection-grant-option" htmlFor={`${listId}-${index}`} key={option.id}>
                    <input
                      id={`${listId}-${index}`}
                      type="checkbox"
                      value={option.id}
                      checked={checked}
                      disabled={!checked && props.draft.ids.length >= connectionListMaxItems}
                      onChange={(event) =>
                        props.onChange({
                          mode: "restricted",
                          ids: event.target.checked
                            ? [...props.draft.ids, option.id]
                            : props.draft.ids.filter((id) => id !== option.id),
                        })
                      }
                    />
                    <span>
                      <code>{option.name}</code>
                      <small>{option.provider}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          ) : (
            <p className="policy-rule-empty">{t("access.policy.editor.noConnections")}</p>
          )}
          {issue ? (
            <p className="policy-rule-error">
              {t(
                issue === "required"
                  ? "access.policy.editor.connectionsRequired"
                  : "access.policy.editor.tooManyConnections",
              )}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
