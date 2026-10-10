import type { ActivityFilters } from "./activity-page";
import type { ApprovalRecord, RunLog } from "./model";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  activityApprovalsPath,
  activityEventMatches,
  activityEvents,
  activityFiltersFromSearchParams,
  activityRunsPath,
  ActivityPage,
  approvalActivityStatus,
  runActivityStatus,
} from "./activity-page";

vi.mock("@embra/i18n/react", () => ({
  useTranslate() {
    return (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${Object.values(params).join(",")}` : key;
  },
}));

describe("activityEvents", () => {
  it("merges runs and approvals into one feed, newest first", () => {
    const events = activityEvents([run("run-1"), run("run-2")], [approval("approval-1", "pending")]);
    expect(events.map((event) => event.id)).toEqual(["run-run-2", "run-run-1", "approval-approval-1"]);
    // Approvals sit at their decision time when decided.
    const decided = activityEvents(
      [run("run-1")],
      [{ ...approval("approval-1", "approved"), decidedAt: "2026-07-06T09:00:30.000Z" }],
    );
    expect(decided.map((event) => event.id)).toEqual(["approval-approval-1", "run-run-1"]);
  });
});

describe("runActivityStatus", () => {
  it("classifies policy refusals and auth denials as denied, other errors as failed", () => {
    expect(runActivityStatus(run("ok-run"))).toBe("ok");
    expect(runActivityStatus({ ...run("denied-run"), ok: false, errorCode: "action_not_allowed" })).toBe("denied");
    expect(
      runActivityStatus({
        ...run("policy-run"),
        ok: false,
        policy: { allowed: false, checks: [] },
      }),
    ).toBe("denied");
    expect(runActivityStatus({ ...run("auth-run"), ok: false, errorCode: "forbidden" })).toBe("denied");
    expect(runActivityStatus({ ...run("failed-run"), ok: false, errorCode: "rate_limited" })).toBe("failed");
    expect(runActivityStatus({ ...run("failed-no-code"), ok: false })).toBe("failed");
  });
});

describe("approvalActivityStatus", () => {
  it("maps approval lifecycle onto feed statuses", () => {
    expect(approvalActivityStatus(approval("a", "pending"))).toBe("pending");
    expect(approvalActivityStatus(approval("a", "approved"))).toBe("ok");
    expect(approvalActivityStatus(approval("a", "executed"))).toBe("ok");
    expect(approvalActivityStatus(approval("a", "denied"))).toBe("denied");
    expect(approvalActivityStatus(approval("a", "expired"))).toBe("failed");
    expect(approvalActivityStatus(approval("a", "failed"))).toBe("failed");
  });
});

describe("activityEventMatches", () => {
  const tokenRun = { ...run("run-token"), runtimeTokenId: "token-1", connectionId: "conn-1" };
  const adminRun = run("run-admin");
  const events = activityEvents([tokenRun, adminRun], [approval("approval-1", "pending")]);

  it("matches every set filter against the event", () => {
    const event = events.find((entry) => entry.id === "run-run-token")!;
    expect(activityEventMatches(event, filters({ agent: "token-1" }))).toBe(true);
    expect(activityEventMatches(event, filters({ agent: "__admin__" }))).toBe(false);
    expect(
      activityEventMatches(events.find((entry) => entry.id === "run-run-admin")!, filters({ agent: "__admin__" })),
    ).toBe(true);
    expect(activityEventMatches(event, filters({ connection: "conn-1" }))).toBe(true);
    expect(activityEventMatches(event, filters({ connection: "gmail" }))).toBe(true); // service form
    expect(activityEventMatches(event, filters({ connection: "other" }))).toBe(false);
    expect(activityEventMatches(event, filters({ status: "ok" }))).toBe(true);
    expect(activityEventMatches(event, filters({ status: "pending" }))).toBe(false);
  });

  it("scopes approval deep links to the approval and the runs it gated", () => {
    const gatedRun = events.find((entry) => entry.id === "approval-approval-1")!;
    expect(activityEventMatches(gatedRun, filters({ approval: "approval-1" }))).toBe(true);
    expect(activityEventMatches(gatedRun, filters({ approval: "other" }))).toBe(false);
    expect(activityEventMatches(events[0]!, filters({ approval: "approval-1" }))).toBe(false);
  });

  it("restricts kinds and matches legacy run filters", () => {
    const approvalEvent = events.find((entry) => entry.id === "approval-approval-1")!;
    expect(activityEventMatches(approvalEvent, filters({ kind: "run" }))).toBe(false);
    expect(activityEventMatches(approvalEvent, filters({ kind: "approval" }))).toBe(true);
    expect(activityEventMatches(approvalEvent, filters({ actionId: "gmail.search_threads" }))).toBe(true);
    expect(activityEventMatches(approvalEvent, filters({ actionId: "other.action" }))).toBe(false);
    expect(activityEventMatches(approvalEvent, filters({ caller: "web" }))).toBe(true);
  });

  it("keeps legacy ok=false links matching only errored runs", () => {
    const failedEvent = {
      id: "run-failed",
      kind: "run" as const,
      at: "2026-07-06T09:00:00.000Z",
      run: { ...run("failed"), ok: false, errorCode: "boom" },
    };
    expect(activityEventMatches(failedEvent, filters({ errorsOnly: true }))).toBe(true);
    expect(activityEventMatches(events.find((entry) => entry.kind === "run")!, filters({ errorsOnly: true }))).toBe(
      false,
    );
    expect(
      activityEventMatches(events.find((entry) => entry.kind === "approval")!, filters({ errorsOnly: true })),
    ).toBe(false);
  });
});

describe("activityRunsPath", () => {
  it("maps service-form connections and legacy filters onto /api/runs params", () => {
    expect(activityRunsPath({ filters: filters({ connection: "gmail" }), connectionIsId: false })).toBe(
      "/api/runs?limit=50&service=gmail",
    );
    expect(
      activityRunsPath({
        cursor: "next cursor",
        filters: filters({ connection: "gmail", actionId: "gmail.search_threads", caller: "mcp" }),
        connectionIsId: false,
      }),
    ).toBe("/api/runs?limit=50&cursor=next+cursor&service=gmail&actionId=gmail.search_threads&caller=mcp");
  });

  it("keeps a connection id out of the service param and narrows ok server-side", () => {
    expect(activityRunsPath({ filters: filters({ connection: "conn-1" }), connectionIsId: true })).toBe(
      "/api/runs?limit=50",
    );
    expect(activityRunsPath({ filters: filters({ status: "ok" }), connectionIsId: false })).toBe(
      "/api/runs?limit=50&ok=true",
    );
    expect(activityRunsPath({ filters: filters({ status: "denied" }), connectionIsId: false })).toBe(
      "/api/runs?limit=50&ok=false",
    );
    expect(activityRunsPath({ filters: filters({ status: "failed" }), connectionIsId: false })).toBe(
      "/api/runs?limit=50&ok=false",
    );
    expect(activityRunsPath({ filters: filters({ errorsOnly: true }), connectionIsId: false })).toBe(
      "/api/runs?limit=50&ok=false",
    );
  });
});

describe("activityApprovalsPath", () => {
  it("passes the pending status through and keeps cursors", () => {
    expect(activityApprovalsPath({ filters: filters() })).toBe("/api/approvals?status=all");
    expect(activityApprovalsPath({ filters: filters({ status: "pending" }) })).toBe("/api/approvals?status=pending");
    expect(activityApprovalsPath({ filters: filters(), cursor: "abc" })).toBe("/api/approvals?status=all&cursor=abc");
  });
});

describe("activityFiltersFromSearchParams", () => {
  it("reads the canonical filter params", () => {
    expect(
      activityFiltersFromSearchParams(
        new URLSearchParams("agent=token-1&connection=conn-1&status=denied&approval=ap-1&kind=approval"),
      ),
    ).toEqual(
      filters({ agent: "token-1", connection: "conn-1", status: "denied", approval: "ap-1", kind: "approval" }),
    );
  });

  it("maps legacy /runs params onto the new filters", () => {
    expect(
      activityFiltersFromSearchParams(new URLSearchParams("service=gmail&actionId=gmail.search&caller=mcp&ok=false")),
    ).toEqual(filters({ connection: "gmail", actionId: "gmail.search", caller: "mcp", errorsOnly: true }));
    expect(activityFiltersFromSearchParams(new URLSearchParams("ok=true"))).toEqual(filters({ status: "ok" }));
  });

  it("applies the route preset when no kind param is set", () => {
    expect(activityFiltersFromSearchParams(new URLSearchParams(), "run")).toEqual(filters({ kind: "run" }));
    expect(activityFiltersFromSearchParams(new URLSearchParams("kind=approval"), "run")).toEqual(
      filters({ kind: "approval" }),
    );
  });
});

describe("ActivityPage", () => {
  it("keeps filters visible when nothing matches", () => {
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(ActivityPage, { initialRuns: [], connections: [], runtimeTokens: [] }),
      ),
    );
    expect(markup).toContain("run-action-filter");
    expect(markup).toContain("activity.empty");
  });

  it("merges runs and approvals into one ordered feed", () => {
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(ActivityPage, { initialRuns: [run("run-1")], connections: [], runtimeTokens: [] }),
      ),
    );
    expect(markup).toContain("activity.request.ran");
    for (const column of ["time", "agent", "request", "connection", "result"]) {
      expect(markup).toContain(`activity.columns.${column}`);
    }
  });

  it("renders denied rows with the destructive marker", () => {
    const denied = { ...run("denied-1"), ok: false, errorCode: "action_not_allowed" };
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(ActivityPage, { initialRuns: [denied], connections: [], runtimeTokens: [] }),
      ),
    );
    expect(markup).toContain("activity-denied");
    expect(markup).toContain("activity.request.deniedReason");
  });

  it("expands a run row into its detail context", () => {
    const auditRun: RunLog = {
      ...run("execution-policy"),
      actionId: "github.delete_repository",
      ok: false,
      runtimeTokenId: "token-1",
      connectionProfile: { displayName: "Finance workspace" },
      outputSummary: { threadCount: 2 },
      errorMessage: "blocked by policy",
      policy: {
        allowed: false,
        checks: [{ source: "token", outcome: "block_match", rule: "github.delete_repository" }],
      },
    };
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(ActivityPage, {
          initialRuns: [auditRun],
          connections: [],
          runtimeTokens: [],
          initialExpanded: [auditRun.id],
        }),
      ),
    );
    expect(markup).toContain("Finance workspace");
    expect(markup).toContain("threadCount");
    expect(markup).toContain("execution-policy");
    expect(markup).toContain("runs.policyBlocked");
    expect(markup).toContain("access.policy.sources.token: github.delete_repository");
    expect(markup).toContain("runs.runtimeToken: token-1");
    expect(markup).toContain("blocked by policy");
  });

  it("labels token agents by name and untokened rows as admin", () => {
    const tokenRun = { ...run("run-token"), runtimeTokenId: "token-1" };
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(ActivityPage, {
          initialRuns: [tokenRun],
          connections: [],
          runtimeTokens: [{ id: "token-1", name: "Claude" } as never],
        }),
      ),
    );
    expect(markup).toContain("Claude");
    const admin = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(ActivityPage, { initialRuns: [run("run-admin")], connections: [], runtimeTokens: [] }),
      ),
    );
    expect(admin).toContain("activity.admin");
  });
});

function filters(input: Partial<ActivityFilters> = {}): ActivityFilters {
  return {
    agent: null,
    connection: null,
    status: null,
    approval: null,
    kind: null,
    actionId: "",
    caller: null,
    errorsOnly: false,
    ...input,
  };
}

function run(id: string): RunLog {
  return {
    id,
    service: "gmail",
    actionId: "gmail.search_threads",
    caller: "http",
    startedAt: "2026-07-06T09:00:00.000Z",
    completedAt: "2026-07-06T09:00:00.727Z",
    durationMs: 727,
    ok: true,
    inputSummary: {},
  };
}

function approval(id: string, status: ApprovalRecord["status"]): ApprovalRecord {
  return {
    id,
    kind: "action",
    actionId: "gmail.search_threads",
    service: "gmail",
    operationType: "read",
    caller: "web",
    status,
    createdAt: "2026-07-05T09:00:00.000Z",
    updatedAt: "2026-07-05T09:00:00.000Z",
    expiresAt: "2026-07-06T09:00:00.000Z",
  };
}
