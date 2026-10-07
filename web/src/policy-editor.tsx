import type { ApprovalOperationType, PolicyRules, ProviderDefinition } from "./model";
import type { AllowMode, PolicyEditorDraft, PolicyResource } from "./policy";
import type { ReactNode } from "react";

import { useTranslate } from "@embra/i18n/react";
import { CircleAlert, Plus, Trash2 } from "lucide-react";
import { useId, useMemo, useState } from "react";
import {
  filterPolicyRuleCandidates,
  isKnownPolicyRule,
  parsePolicyLines,
  policyRuleCandidates,
  policyRuleIssue,
  validatePolicyEditorDraft,
} from "./policy";
import { PolicySuggestionInput } from "./policy-suggestion-input";
import { Badge } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

interface PolicyEditorProps {
  draft: PolicyEditorDraft;
  providers: ProviderDefinition[];
  includeProxies: boolean;
  proxyAccess?: "constraint" | "grant";
  /** "layer" edits all three approval fields; "token" omits the exempt list (a token can widen, never exempt). */
  approvalScope?: "layer" | "token";
  connectionEditor?: ReactNode;
  connectionInvalid?: boolean;
  onChange(draft: PolicyEditorDraft): void;
}

export function PolicyEditor(props: PolicyEditorProps): ReactNode {
  const t = useTranslate();
  const issues = validatePolicyEditorDraft(props.draft, props.includeProxies);
  const actionIssue = issues.find((issue) => issue.field === "allowedActions" || issue.field === "blockedActions");
  const proxyIssue = issues.find((issue) => issue.field === "allowedProxies" || issue.field === "blockedProxies");
  const approvalIssue = issues.find(
    (issue) => issue.field === "approvalRequiredActions" || issue.field === "approvalExemptActions",
  );
  const actionEditor = (
    <PolicyResourceEditor resource="action" draft={props.draft} providers={props.providers} onChange={props.onChange} />
  );
  const approvalEditor = props.approvalScope ? (
    <PolicyApprovalEditor
      scope={props.approvalScope}
      draft={props.draft}
      providers={props.providers}
      onChange={props.onChange}
    />
  ) : null;

  return (
    <div className="structured-policy-editor">
      {props.includeProxies ? (
        <Tabs defaultValue="action">
          <TabsList variant="line" aria-label={t("access.policy.editor.resourceLabel")}>
            <TabsTrigger value="action">
              {t("access.policy.editor.actionsTab")}
              {actionIssue ? <CircleAlert className="policy-tab-issue" aria-hidden /> : null}
            </TabsTrigger>
            <TabsTrigger value="proxy">
              {t("access.policy.editor.proxiesTab")}
              {proxyIssue ? <CircleAlert className="policy-tab-issue" aria-hidden /> : null}
            </TabsTrigger>
            {approvalEditor ? (
              <TabsTrigger value="approval">
                {t("access.policy.editor.approvalsTab")}
                {approvalIssue ? <CircleAlert className="policy-tab-issue" aria-hidden /> : null}
              </TabsTrigger>
            ) : null}
            {props.connectionEditor ? (
              <TabsTrigger value="connection">
                {t("access.policy.editor.connectionsTitle")}
                {props.connectionInvalid ? <CircleAlert className="policy-tab-issue" aria-hidden /> : null}
              </TabsTrigger>
            ) : null}
          </TabsList>
          <TabsContent value="action">
            {actionEditor}
            {actionIssue ? <PolicyEditorError issue={actionIssue} /> : null}
          </TabsContent>
          <TabsContent value="proxy">
            <PolicyResourceEditor
              resource="proxy"
              draft={props.draft}
              providers={props.providers}
              proxyAccess={props.proxyAccess}
              onChange={props.onChange}
            />
            {proxyIssue ? <PolicyEditorError issue={proxyIssue} /> : null}
          </TabsContent>
          {approvalEditor ? (
            <TabsContent value="approval">
              {approvalEditor}
              {approvalIssue ? <PolicyEditorError issue={approvalIssue} /> : null}
            </TabsContent>
          ) : null}
          {props.connectionEditor ? <TabsContent value="connection">{props.connectionEditor}</TabsContent> : null}
        </Tabs>
      ) : (
        <>
          {actionEditor}
          {actionIssue ? <PolicyEditorError issue={actionIssue} /> : null}
          {approvalEditor}
          {approvalIssue ? <PolicyEditorError issue={approvalIssue} /> : null}
        </>
      )}
    </div>
  );
}

const approvalOperationTypes: ApprovalOperationType[] = ["read", "write", "destructive"];

const approvalPresets: Array<{ key: "gated" | "destructiveOnly"; operations: ApprovalOperationType[] }> = [
  { key: "gated", operations: ["write", "destructive"] },
  { key: "destructiveOnly", operations: ["destructive"] },
];

interface PolicyApprovalEditorProps {
  scope: "layer" | "token";
  draft: PolicyEditorDraft;
  providers: ProviderDefinition[];
  onChange(draft: PolicyEditorDraft): void;
}

function PolicyApprovalEditor(props: PolicyApprovalEditorProps): ReactNode {
  const t = useTranslate();
  const requiredOperations = props.draft.rules.requireApprovalOperations ?? [];

  function setApprovalField(
    field: "requireApprovalOperations" | "approvalRequiredActions" | "approvalExemptActions",
    values: ApprovalOperationType[] | string[],
  ): void {
    props.onChange({ ...props.draft, rules: { ...props.draft.rules, [field]: values } });
  }

  function toggleOperation(operation: ApprovalOperationType, enabled: boolean): void {
    const next = approvalOperationTypes.filter((item) =>
      item === operation ? enabled : requiredOperations.includes(item),
    );
    setApprovalField("requireApprovalOperations", next);
  }

  return (
    <div className="policy-approval-editor">
      <section className="policy-rule-section">
        <div className="policy-rule-heading">
          <div>
            <h4>{t("access.policy.editor.requireOperationsLabel")}</h4>
            <p>
              {t(
                props.scope === "token"
                  ? "access.policy.editor.approvalTokenHint"
                  : "access.policy.editor.approvalsHint",
              )}
            </p>
          </div>
        </div>
        <div
          className="policy-approval-presets"
          role="group"
          aria-label={t("access.policy.editor.approvalPresetsLabel")}
        >
          {approvalPresets.map((preset) => (
            <Button
              type="button"
              variant="outline"
              size="sm"
              key={preset.key}
              onClick={() => setApprovalField("requireApprovalOperations", [...preset.operations])}
            >
              {t(`access.policy.editor.preset${preset.key === "gated" ? "Gated" : "DestructiveOnly"}`)}
            </Button>
          ))}
        </div>
        <div className="policy-approval-operations">
          {approvalOperationTypes.map((operation) => (
            <label key={operation}>
              <input
                type="checkbox"
                checked={requiredOperations.includes(operation)}
                onChange={(event) => toggleOperation(operation, event.currentTarget.checked)}
              />
              <span>
                {t(
                  `access.policy.editor.operation${operation === "read" ? "Read" : operation === "write" ? "Write" : "Destructive"}`,
                )}
              </span>
            </label>
          ))}
        </div>
      </section>

      <RuleListEditor
        resource="action"
        effect="require"
        values={props.draft.rules.approvalRequiredActions ?? []}
        providers={props.providers}
        onChange={(values) => setApprovalField("approvalRequiredActions", values)}
      />

      {props.scope === "layer" ? (
        <RuleListEditor
          resource="action"
          effect="exempt"
          values={props.draft.rules.approvalExemptActions ?? []}
          providers={props.providers}
          onChange={(values) => setApprovalField("approvalExemptActions", values)}
        />
      ) : null}
    </div>
  );
}

function PolicyEditorError(props: { issue: ReturnType<typeof validatePolicyEditorDraft>[number] }): ReactNode {
  const t = useTranslate();
  return (
    <div className="policy-editor-error" role="alert">
      <CircleAlert size={15} />
      <span>{draftIssueLabel(props.issue, t)}</span>
    </div>
  );
}

interface PolicyResourceEditorProps {
  resource: PolicyResource;
  draft: PolicyEditorDraft;
  providers: ProviderDefinition[];
  proxyAccess?: "constraint" | "grant";
  onChange(draft: PolicyEditorDraft): void;
}

function PolicyResourceEditor(props: PolicyResourceEditorProps): ReactNode {
  const t = useTranslate();
  const fields = resourceFields(props.resource);
  const allowMode = props.draft[fields.allowMode];
  const grantsProxy = props.resource === "proxy" && props.proxyAccess === "grant";

  function setAllowMode(mode: AllowMode): void {
    props.onChange({
      ...props.draft,
      [fields.allowMode]: mode,
      rules: mode === "unrestricted" ? { ...props.draft.rules, [fields.allowed]: [] } : props.draft.rules,
    });
  }

  function setRules(field: keyof PolicyRules, values: string[]): void {
    props.onChange({
      ...props.draft,
      ...(grantsProxy && field === fields.allowed
        ? { [fields.allowMode]: values.length > 0 ? "restricted" : "unrestricted" }
        : {}),
      rules: { ...props.draft.rules, [field]: values },
    });
  }

  return (
    <div className="policy-resource-editor">
      {!grantsProxy ? (
        <fieldset className="policy-allow-mode">
          <legend>{t("access.policy.editor.allowMode")}</legend>
          <label>
            <input
              type="radio"
              name={`${props.resource}-allow-mode`}
              value="unrestricted"
              checked={allowMode === "unrestricted"}
              onChange={() => setAllowMode("unrestricted")}
            />
            <span>
              <strong>{t("access.policy.editor.unrestricted")}</strong>
              <small>{t(`access.policy.editor.${props.resource}UnrestrictedHint`)}</small>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name={`${props.resource}-allow-mode`}
              value="restricted"
              checked={allowMode === "restricted"}
              onChange={() => setAllowMode("restricted")}
            />
            <span>
              <strong>{t("access.policy.editor.restricted")}</strong>
              <small>{t(`access.policy.editor.${props.resource}RestrictedHint`)}</small>
            </span>
          </label>
        </fieldset>
      ) : null}

      {grantsProxy || allowMode === "restricted" ? (
        <RuleListEditor
          resource={props.resource}
          effect="allow"
          values={props.draft.rules[fields.allowed]}
          providers={props.providers}
          onChange={(values) => setRules(fields.allowed, values)}
        />
      ) : null}

      {!grantsProxy ? (
        <RuleListEditor
          resource={props.resource}
          effect="block"
          values={props.draft.rules[fields.blocked]}
          providers={props.providers}
          onChange={(values) => setRules(fields.blocked, values)}
        />
      ) : null}

      <details className="policy-advanced-editor">
        <summary>{t("access.policy.editor.advanced")}</summary>
        <p>{t("access.policy.editor.advancedHint")}</p>
        <div className="policy-advanced-grid">
          <Label className="field">
            <span>{t("access.policy.editor.allowedRaw")}</span>
            <Textarea
              value={grantsProxy || allowMode === "restricted" ? props.draft.rules[fields.allowed].join("\n") : ""}
              placeholder={props.resource === "action" ? "github.*" : "github"}
              onChange={(event) => {
                const values = parsePolicyLines(event.target.value);
                props.onChange({
                  ...props.draft,
                  [fields.allowMode]: values.length > 0 ? "restricted" : "unrestricted",
                  rules: { ...props.draft.rules, [fields.allowed]: values },
                });
              }}
            />
          </Label>
          {!grantsProxy ? (
            <Label className="field">
              <span>{t("access.policy.editor.blockedRaw")}</span>
              <Textarea
                value={props.draft.rules[fields.blocked].join("\n")}
                placeholder={props.resource === "action" ? "github.delete_repository" : "*"}
                onChange={(event) => setRules(fields.blocked, parsePolicyLines(event.target.value))}
              />
            </Label>
          ) : null}
        </div>
      </details>
    </div>
  );
}

type RuleEffect = "allow" | "block" | "require" | "exempt";

interface RuleListEditorProps {
  resource: PolicyResource;
  effect: RuleEffect;
  values: string[];
  providers: ProviderDefinition[];
  onChange(values: string[]): void;
}

interface RuleEffectLabels {
  list: string;
  hint: string;
  input: string;
  badge: string;
  tone: "success" | "warning" | "error" | undefined;
}

function ruleEffectLabels(effect: RuleEffect): RuleEffectLabels {
  if (effect === "require") {
    return { list: "requiredList", hint: "RequiredHint", input: "RequiredInput", badge: "require", tone: "warning" };
  }
  if (effect === "exempt") {
    return { list: "exemptList", hint: "ExemptHint", input: "ExemptInput", badge: "exempt", tone: "success" };
  }
  return {
    list: effect === "allow" ? "allowedList" : "blockedList",
    hint: effect === "allow" ? "AllowedHint" : "BlockedHint",
    input: effect === "allow" ? "AllowedInput" : "BlockedInput",
    badge: effect,
    tone: effect === "allow" ? "success" : "error",
  };
}

function RuleListEditor(props: RuleListEditorProps): ReactNode {
  const t = useTranslate();
  const labels = ruleEffectLabels(props.effect);
  const listId = useId();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const candidates = useMemo(
    () => policyRuleCandidates(props.providers, props.resource),
    [props.providers, props.resource],
  );
  const suggestions = useMemo(() => {
    return input.trim() ? filterPolicyRuleCandidates(candidates, input, 6) : [];
  }, [candidates, input]);

  function addRule(): boolean {
    const rule = input.trim();
    if (!rule) {
      setError(t("access.policy.editor.ruleRequired"));
      return false;
    }
    const issue = policyRuleIssue(rule, props.resource);
    if (issue) {
      setError(t(`access.policy.editor.${issue === "too_long" ? "ruleTooLong" : "ruleInvalid"}`));
      return false;
    }
    if (props.values.includes(rule)) {
      setError(t("access.policy.editor.ruleDuplicate"));
      return false;
    }
    if (props.values.length >= 128) {
      setError(t("access.policy.editor.tooManyRules"));
      return false;
    }
    props.onChange([...props.values, rule]);
    setInput("");
    setError(null);
    setSuggestionsOpen(false);
    return true;
  }

  return (
    <section className="policy-rule-section">
      <div className="policy-rule-heading">
        <div>
          <h4>{t(`access.policy.editor.${labels.list}`)}</h4>
          <p>{t(`access.policy.editor.${props.resource}${labels.hint}`)}</p>
        </div>
        <span>{t("access.policy.editor.ruleCount", { count: props.values.length })}</span>
      </div>
      <div className="policy-rule-add">
        <label className="sr-only" htmlFor={`${listId}-input`}>
          {t(`access.policy.editor.${props.resource}${labels.input}`)}
        </label>
        <PolicySuggestionInput
          id={`${listId}-input`}
          value={input}
          suggestions={suggestions}
          invalid={Boolean(error)}
          open={suggestionsOpen}
          placeholder={t(`access.policy.editor.${props.resource}${labels.input}`)}
          onChange={(value) => {
            setInput(value);
            setError(null);
          }}
          onOpenChange={setSuggestionsOpen}
          onSubmit={addRule}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t("access.policy.editor.addRule")}
          onClick={(event) => {
            if (addRule()) {
              event.currentTarget.focus();
            }
          }}
        >
          <Plus size={16} />
        </Button>
      </div>
      {error ? <p className="policy-rule-error">{error}</p> : null}
      {props.values.length > 0 ? (
        <div className="policy-rule-list">
          {props.values.map((rule) => {
            const known = isKnownPolicyRule(rule, props.resource, props.providers);
            return (
              <div className="policy-rule-row" key={rule}>
                <code>{rule}</code>
                {!known ? <span className="policy-rule-unknown">{t("access.policy.editor.unknownRule")}</span> : null}
                <Badge tone={labels.tone}>{t(`access.policy.editor.${labels.badge}`)}</Badge>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("access.policy.editor.removeRule", { rule })}
                  onClick={() => props.onChange(props.values.filter((value) => value !== rule))}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="policy-rule-empty">{t("access.policy.editor.noRules")}</p>
      )}
    </section>
  );
}

function resourceFields(resource: PolicyResource): {
  allowed: "allowedActions" | "allowedProxies";
  blocked: "blockedActions" | "blockedProxies";
  allowMode: "actionAllowMode" | "proxyAllowMode";
} {
  return resource === "action"
    ? { allowed: "allowedActions", blocked: "blockedActions", allowMode: "actionAllowMode" }
    : { allowed: "allowedProxies", blocked: "blockedProxies", allowMode: "proxyAllowMode" };
}

function draftIssueLabel(
  issue: ReturnType<typeof validatePolicyEditorDraft>[number],
  t: NonNullable<ReturnType<typeof useTranslate>>,
): string {
  if (issue.code === "required") {
    return t(
      issue.field === "allowedActions"
        ? "access.policy.editor.actionAllowRequired"
        : "access.policy.editor.proxyAllowRequired",
    );
  }
  if (issue.code === "too_many") {
    return t("access.policy.editor.tooManyRules");
  }
  return t(issue.code === "too_long" ? "access.policy.editor.ruleTooLong" : "access.policy.editor.ruleInvalid");
}
