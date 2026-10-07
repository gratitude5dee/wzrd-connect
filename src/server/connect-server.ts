import type { CatalogStore, RuntimeActionDefinition } from "../catalog-store.ts";
import type { ConnectionService, ConnectionSummary } from "../connection-service.ts";
import type { ActionPolicySnapshot } from "../core/action-policy.ts";
import type { ActionSearchDocument, ActionSearchIndexProvider } from "../core/action-search.ts";
import type { ProviderHttpDispatchOptions } from "../core/provider-http-dispatch.ts";
import type { RuntimeLogger, TransitFileUpload } from "../core/types.ts";
import type { MarketplaceConfigInput, MarketplaceService } from "../marketplace/marketplace-service.ts";
import type { OAuthClientConfigInput } from "../oauth/oauth-client-config-service.ts";
import type { IProviderLoader } from "../providers/provider-loader.ts";
import type { SaasExecutionService } from "../saas/saas-execution-service.ts";
import type { SaasOAuthService } from "../saas/saas-oauth-service.ts";
import type { SaasProjectService } from "../saas/saas-project-service.ts";
import type { TriggerMaintenance } from "../triggers/maintenance.ts";
import type { TriggerRunner } from "../triggers/trigger-runner.ts";
import type { LocalAuthOptions } from "./api/auth.ts";
import type { RuntimeActionHttpResult } from "./api/runtime-api.ts";
import type { ApprovalGate, ApprovalGateRequest } from "./approvals/approval-gate.ts";
import type { ApprovalService, CreateGrantInput } from "./approvals/approval-service.ts";
import type { ITransitFileService } from "./files/transit-file-store.ts";
import type { ApprovalGrantRecord, ApprovalRecord } from "./storage/approval-store.ts";
import type { IIdempotencyStore } from "./storage/idempotency-store.ts";
import type { IRuntimePolicyStore } from "./storage/runtime-policy-store.ts";
import type { RunLogCaller, RunLogListInput } from "./storage/runtime-store.ts";
import type { RuntimeTokenService } from "./storage/runtime-token-service.ts";
import type { Context, MiddlewareHandler } from "hono";

import { Hono } from "hono";
import { compress } from "hono/compress";
import { ConnectionError, defaultConnectionName } from "../connection-service.ts";
import { ActionPolicyService, emptyPolicyRules } from "../core/action-policy.ts";
import { DEFAULT_ACTION_SEARCH_LIMIT, createActionSearchIndexProvider, searchActions } from "../core/action-search.ts";
import {
  optionalBoolean,
  optionalInteger,
  optionalRecord,
  optionalString,
  requiredRawString,
  requiredString,
  requiredStringArray,
} from "../core/cast.ts";
import { PromiseCache } from "../core/promise-cache.ts";
import { withProviderHttpDispatch } from "../core/provider-http-dispatch.ts";
import { MarketplaceError } from "../marketplace/marketplace-service.ts";
import { OAuthClientConfigError, OAuthClientConfigService } from "../oauth/oauth-client-config-service.ts";
import { OAuthCallbackError, OAuthFlowError, OAuthFlowService } from "../oauth/oauth-flow-service.ts";
import { ProviderDispatchRequestError, toProviderExecutionError } from "../providers/provider-runtime.ts";
import { SaasError } from "../saas/saas-client.ts";
import {
  ActionInputDepthError,
  createIdempotencyExpiry,
  hashActionRequest,
  hashIdempotencyKey,
  readIdempotencyKey,
} from "./actions/action-idempotency.ts";
import { ActionRunner } from "./actions/action-runner.ts";
import { summarizeForRunLog } from "./actions/run-log-summary.ts";
import { renderActionMarkdown } from "./api/action-markdown.ts";
import {
  clearLocalAuthCookie,
  createLocalAuthMiddleware,
  hasAdminBearer,
  readLocalAuthSession,
  readRuntimeGrant,
} from "./api/auth.ts";
import { getResponseCachePolicy } from "./api/cache-policy.ts";
import { createConnectionRoutes } from "./api/connection-routes.ts";
import { HttpRequestError, internalError, jsonError, notFound, readJsonBody } from "./api/http-utils.ts";
import { renderOAuthCompletionPage } from "./api/oauth-completion-page.ts";
import { policyRequestMaxBytes, readRuntimePolicyRules, readTokenPolicy } from "./api/policy-input.ts";
import { serializeRuntimeTriggerPermissions } from "./api/runtime-api.ts";
import {
  mapConnectionErrorStatus,
  serializeRuntimeAction,
  serializeRuntimeActionResult,
  serializeRuntimeActionService,
  serializeRuntimeConnectedApp,
  serializeRuntimeFailure,
  serializeRuntimeProvider,
  serializeRuntimeProviderSetup,
  unknownActionFailure,
  unknownServiceFailure,
  writeRuntimeActionHttpResult,
  writeRuntimeFailure,
  writeRuntimeSuccess,
} from "./api/runtime-api.ts";
import { renderSaasCompletionPage } from "./api/saas-completion-page.ts";
import { ApprovalRequestError, approvalPollIntervalSeconds } from "./approvals/approval-service.ts";
import { TransitFileError } from "./files/transit-file-store.ts";
import { ProxyRunner } from "./proxy/proxy-runner.ts";
import { decodeRunLogCursor } from "./storage/runtime-store.ts";
import { summarizeRuntimeToken } from "./storage/runtime-token-service.ts";

type McpModule = typeof import("../mcp.ts");

/**
 * The MCP module pulls in @modelcontextprotocol/server and zod, which no other startup path needs, so it is
 * loaded on the first /mcp request. The cache shares one in-flight import; a rejected import is evicted so
 * transient resolution failures retry, while evaluation errors rethrow identically.
 */
const mcpModule = new PromiseCache<McpModule>();

function loadMcpModule(): Promise<McpModule> {
  return mcpModule.get("", () => import("../mcp.ts"));
}

/** The Scalar API reference is only rendered for /docs, so its package is loaded on the first request. */
const docsHandler = new PromiseCache<MiddlewareHandler>();

function loadDocsHandler(openapiUrl = "/openapi.json"): Promise<MiddlewareHandler> {
  return docsHandler.get(openapiUrl, async () => {
    const { Scalar } = await import("@scalar/hono-api-reference");
    return Scalar({
      pageTitle: "OOMOL Connect API Reference",
      url: openapiUrl,
      theme: "default",
      darkMode: false,
      forceDarkModeState: "light",
      customCss: `
          :root {
            --scalar-color-accent: rgb(59, 99, 251);
            --scalar-background-accent: rgba(59, 99, 251, 0.12);
          }
        `,
    });
  });
}

/**
 * Dependencies required to construct the local connector server.
 */
export interface IConnectServerOptions {
  providerHttpDispatch?: ProviderHttpDispatchOptions;
  catalog: CatalogStore;
  /** Public origin of this runtime, used for the HTTP request examples in Action guides. */
  publicOrigin: string;
  providerLoader: IProviderLoader;
  connections: ConnectionService;
  oauthClientConfigs: OAuthClientConfigService;
  oauthFlow: OAuthFlowService;
  runtimeTokens: RuntimeTokenService;
  actions: ActionRunner;
  triggers?: TriggerRunner;
  triggerMaintenance?: TriggerMaintenance;
  idempotency: IIdempotencyStore;
  transitFiles: ITransitFileService;
  /** Approval checkpoint; absent means the approval overlay and routes stay off. */
  approvals?: ApprovalService;
  uploadTransitFile?: (request: Request) => Promise<TransitFileUpload>;
  auth?: LocalAuthOptions;
  actionPolicy?: ActionPolicyService;
  runtimePolicyStore: IRuntimePolicyStore;
  actionSearch?: ActionSearchIndexProvider;
  registerStaticRoutes?: (app: Hono) => void;
  logger?: RuntimeLogger;
  compressApiResponses?: boolean;
  serveDocumentation?: boolean;
  /**
   * Serves `/api/actions` from a prebuilt catalog asset instead of the
   * in-memory list: the ~40MB list re-serializes (and re-compresses) on every
   * request, which blows the Cloudflare Workers CPU budget. The deployed
   * assets bundle carries `catalog/actions.json`, emitted by
   * `copy-catalog-assets.ts`.
   */
  fetchActionsAsset?: (request: Request) => Promise<Response>;
  /**
   * Serves `/api/providers` from a prebuilt provider-summaries asset instead of
   * the in-memory stringify: a cold Cloudflare isolate must not pay the ~9MB
   * serialization inside its 2s CPU budget (`copy-catalog-assets.ts` emits
   * `catalog/provider-summaries.json`).
   */
  fetchProvidersAsset?: (request: Request) => Promise<Response>;
  marketplace?: MarketplaceService;
  saasProject?: SaasProjectService;
  saas?: SaasExecutionService;
  saasOAuth?: SaasOAuthService;
}

/**
 * Local single-user HTTP server for catalog browsing, credential management,
 * action execution, OpenAPI docs, and MCP tool metadata.
 */
export class ConnectServer {
  private readonly options: IConnectServerOptions;
  private readonly actionSearch: ActionSearchIndexProvider;
  private readonly actionPolicy: ActionPolicyService;
  private readonly proxyRunner: ProxyRunner;
  private readonly policySnapshots = new WeakMap<Request, Promise<ActionPolicySnapshot>>();

  constructor(options: IConnectServerOptions) {
    this.options = options;
    this.actionSearch = options.actionSearch ?? createActionSearchIndexProvider(options.catalog.actions);
    this.actionPolicy = options.actionPolicy ?? new ActionPolicyService();
    this.proxyRunner = new ProxyRunner({
      providerHttpDispatch: options.providerHttpDispatch,
      catalog: options.catalog,
      providerLoader: options.providerLoader,
      connections: options.connections,
      logger: options.logger,
      saas: options.saas,
    });
  }

  createApp(): Hono {
    const app = new Hono();
    const auth = this.options.auth ?? {};

    app.use("*", async (_context, next) => {
      await withProviderHttpDispatch({ operation: "runtime" }, next, this.options.providerHttpDispatch);
    });

    app.use("*", async (context, next) => {
      await next();
      const cachePolicy = getResponseCachePolicy(context.req.method, context.req.path, context.res.status);
      if (cachePolicy) {
        context.header("Cache-Control", cachePolicy.cacheControl);
        if (cachePolicy.cloudflareCdnCacheControl) {
          context.header("Cloudflare-CDN-Cache-Control", cachePolicy.cloudflareCdnCacheControl);
        }
        if (cachePolicy.vary) {
          context.header("Vary", cachePolicy.vary);
        }
      }
    });
    app.get("/health", (context) => context.json({ ok: true }));
    if (this.options.compressApiResponses !== false) {
      // Compress dashboard JSON responses. Scoped to /api/* so the streaming
      // /mcp transport and /v1/proxy pass-through are never buffered/re-encoded.
      // The middleware's content-type filter already skips non-text bodies
      // (e.g. transit file downloads). /api/actions is excluded: its ~40MB body
      // is a precomputed catalog byte string, and re-gzipping it on every
      // request exceeds the Workers CPU budget (503s observed live).
      const gzip = compress();
      app.use("/api/*", (context, next) => (context.req.path === "/api/actions" ? next() : gzip(context, next)));
    }
    app.use("*", createLocalAuthMiddleware(auth));
    if (this.options.marketplace) {
      app.get("/api/marketplace", (context) => context.json(this.options.marketplace!.getState()));
      app.get("/api/marketplace/discovery", (context) => this.getMarketplaceDiscovery(context));
      app.put("/api/marketplace", (context) => this.configureMarketplace(context));
      app.patch("/api/marketplace", (context) => this.configureMarketplace(context));
      app.delete("/api/marketplace", (context) => this.deleteMarketplace(context));
      app.get("/api/provider-preferences", async (context) =>
        context.json(await this.options.marketplace!.listProviderPreferences()),
      );
      app.patch("/api/provider-preferences/:service", (context) =>
        this.updateProviderPreference(context, context.req.param("service")),
      );
    }
    app.get("/v1/health", (context) => writeRuntimeSuccess(context, { ok: true, runtime: "oomol-connect" }));
    app.get("/v1/providers/:service/setup", (context) =>
      this.getRuntimeProviderSetup(context, context.req.param("service")),
    );
    app.get("/v1/providers/:service/trigger-permissions", (context) =>
      this.getRuntimeTriggerPermissions(context, context.req.param("service")),
    );
    app.post("/v1/providers/:service/triggers/:triggerId/execute", (context) => this.executeRuntimeTrigger(context));
    app.get("/api/trigger-subscriptions", async (context) =>
      context.json((await this.options.triggerMaintenance?.list()) ?? []),
    );
    app.post("/api/trigger-subscriptions/:id/cancel", async (context) => {
      if (!this.options.triggerMaintenance)
        throw new HttpRequestError("trigger_not_supported", "Trigger subscriptions are unavailable.", 501);
      await this.options.triggerMaintenance.cancel(context.req.param("id"), context.req.raw.signal);
      return context.json({ ok: true });
    });
    app.post("/api/trigger-subscriptions/:id/abandon", async (context) => {
      if (!this.options.triggerMaintenance)
        throw new HttpRequestError("trigger_not_supported", "Trigger subscriptions are unavailable.", 501);
      await this.options.triggerMaintenance.abandon(context.req.param("id"), context.req.raw.signal);
      return context.json({ ok: true });
    });
    app.get("/v1/providers", (context) => this.listRuntimeProviders(context));
    app.get("/v1/actions", (context) => this.listRuntimeActions(context));
    app.get("/v1/actions/search", (context) => this.searchRuntimeActions(context));
    app.get("/v1/actions/:actionId", (context) => this.getRuntimeAction(context, context.req.param("actionId")));
    app.post("/v1/actions/:actionId", (context) => this.createRuntimeActionRun(context, context.req.param("actionId")));
    app.route("/v1", createConnectionRoutes(this.options));
    app.get("/v1/apps", (context) => this.listRuntimeApps(context));
    app.get("/v1/apps/authenticated", (context) => this.listAuthenticatedRuntimeApps(context));
    app.get("/v1/apps/services/:service", (context) =>
      this.listRuntimeAppsByService(context, context.req.param("service")),
    );
    app.post("/v1/proxy/:service", (context) => this.createRuntimeProxyRequest(context, context.req.param("service")));
    if (this.options.approvals) {
      app.get("/v1/approvals/:id", (context) => this.pollRuntimeApproval(context, context.req.param("id")));
    }

    app.get("/openapi.json", async (context) => {
      const { createOpenApiDocument } = await import("./api/openapi.ts");
      return context.json(
        createOpenApiDocument(this.options.catalog.providers, {
          actionId: optionalString(context.req.query("actionId")),
        }),
      );
    });
    if (this.options.serveDocumentation !== false) {
      // Path-only so the browser resolves it against whichever host it reached the server through: the public
      // origin may name a different host (a default localhost origin, a reverse proxy) and /openapi.json sends no CORS.
      const openapiUrl = `${new URL(this.options.publicOrigin).pathname.replace(/\/+$/, "")}/openapi.json`;
      app.get("/docs", async (context, next) => (await loadDocsHandler(openapiUrl))(context, next));
    }

    // Schema-free listing. The action detail view loads full schemas on demand
    // from /api/actions/:actionId. The catalog is immutable at runtime, so the
    // body and its ETag are precomputed and reused, and unchanged reloads get a
    // 304 instead of re-downloading the payload.
    app.get("/api/providers", (context) => this.listProviderSummaries(context));
    app.get("/api/providers/:service", (context) => this.getProvider(context, context.req.param("service")));

    app.get("/api/actions", async (context) => await this.listActions(context));
    app.get("/api/actions/search", (context) => this.searchApiActions(context));
    app.get("/api/actions/:actionId/agent.md", (context) =>
      this.getActionMarkdown(context, context.req.param("actionId")),
    );
    app.get("/api/actions/:actionId", (context) => this.getAction(context, context.req.param("actionId")));
    app.get("/api/auth/session", async (context) => context.json(await readLocalAuthSession(context, auth)));
    app.post("/api/auth/logout", (context) => {
      clearLocalAuthCookie(context);
      return context.json({ ok: true });
    });

    app.get("/api/connections", (context) => this.listConnections(context));
    app.put("/api/connections/:service", (context) => this.upsertConnection(context, context.req.param("service")));
    app.delete("/api/connections/:service", (context) => this.disconnect(context, context.req.param("service")));

    app.get("/api/runs", (context) => this.listRuns(context));
    app.get("/api/runs/:id", (context) => this.getRun(context, context.req.param("id")));
    app.post("/api/files", (context) => this.createTransitFile(context));
    app.get("/api/files/:fileId", (context) => this.getTransitFile(context, context.req.param("fileId")));
    app.delete("/api/files/:fileId", (context) => this.deleteTransitFile(context, context.req.param("fileId")));
    app.get("/api/runtime-tokens", (context) => this.listRuntimeTokens(context));
    app.post("/api/runtime-tokens", (context) => this.createRuntimeToken(context));
    app.put("/api/runtime-tokens/:id", (context) => this.updateRuntimeToken(context, context.req.param("id")));
    app.delete("/api/runtime-tokens/:id", (context) => this.revokeRuntimeToken(context, context.req.param("id")));
    app.get("/api/runtime-policy", (context) => this.getRuntimePolicy(context));
    app.put("/api/runtime-policy", (context) => this.updateRuntimePolicy(context));
    if (this.options.approvals) {
      app.get("/api/approvals", (context) => this.listApprovals(context));
      app.get("/api/approvals/:id", (context) => this.getApproval(context, context.req.param("id")));
      app.post("/api/approvals/:id/approve", (context) =>
        this.decideApproval(context, context.req.param("id"), "approve"),
      );
      app.post("/api/approvals/:id/deny", (context) => this.decideApproval(context, context.req.param("id"), "deny"));
      app.get("/api/approval-grants", (context) => this.listApprovalGrants(context));
      app.delete("/api/approval-grants/:id", (context) => this.deleteApprovalGrant(context, context.req.param("id")));
    }
    const saas = this.options.saasProject;
    if (saas) {
      app.get("/api/oauth/managed-project", async (context) =>
        context.json(await saas.getState(context.req.raw.signal)),
      );
      app.put("/api/oauth/managed-project", async (context) =>
        context.json(await saas.configure(await readJsonBody(context, 16_384), context.req.raw.signal)),
      );
      app.delete("/api/oauth/managed-project", async (context) => {
        await saas.remove();
        return context.json(await saas.getState(context.req.raw.signal));
      });
      app.get("/api/oauth/managed-project/provider-configs", async (context) =>
        context.json(await saas.listProviderConfigs(context.req.raw.signal)),
      );
      app.get("/api/oauth/sources/:service", async (context) =>
        context.json(await saas.getSource(context.req.param("service"))),
      );
      app.put("/api/oauth/sources/:service", async (context) =>
        context.json(
          await saas.setSource(
            context.req.param("service"),
            await readJsonBody(context, 16_384),
            context.req.raw.signal,
          ),
        ),
      );
    }
    if (saas && this.options.saasOAuth) {
      app.get("/oauth/saas/complete", (context) => {
        context.header(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        );
        context.header("Referrer-Policy", "no-referrer");
        return context.html(renderSaasCompletionPage());
      });
      app.post("/api/oauth/connection-requests/:id/sync", async (context) => {
        const expectedOrigin = saas.requireOrigin();
        if (context.req.header("origin") !== expectedOrigin)
          throw new SaasError(
            "oauth_source_origin_mismatch",
            `Open Console at ${expectedOrigin}, or set OOMOL_CONNECT_ORIGIN to the exact Console address in your browser and restart Connect. localhost and 127.0.0.1 are different origins.`,
            403,
          );
        if (
          context.req.header("x-openconnector-request") !== "sync" ||
          context.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
        )
          return context.json(
            { error: { code: "forbidden", message: "OAuth synchronization requires a same-origin JSON request." } },
            403,
          );
        const result = await this.options.saasOAuth!.syncForBrowser(
          context.req.param("id"),
          "local-admin",
          context.req.raw.signal,
        );
        if (!result) return jsonError(context, 404, "connection_request_not_found", "Connection request not found.");
        context.header("Cache-Control", "private, no-store");
        return context.json(result);
      });
    }
    app.get("/api/oauth/configs", (context) => this.listOAuthConfigs(context));
    app.put("/api/oauth/configs/:service", (context) => this.upsertOAuthConfig(context, context.req.param("service")));
    app.delete("/api/oauth/configs/:service", (context) =>
      this.deleteOAuthConfig(context, context.req.param("service")),
    );
    app.post("/api/oauth/connection-requests", async (context) => {
      try {
        const { consoleOAuthConnectionInput } = await import("./api/connection-input.ts");
        const parsed = consoleOAuthConnectionInput.safeParse(await readJsonBody(context));
        if (!parsed.success) return jsonError(context, 400, "invalid_input", "Invalid OAuth connection request.");
        const { appId, ...input } = parsed.data;
        const target = appId ? await this.options.connections.getStoredConnection(appId) : undefined;
        if (target && (target.service !== input.service || target.connectionName !== input.connectionName))
          return jsonError(context, 400, "invalid_input", "The selected connection no longer matches.");
        return context.json(
          await this.options.oauthFlow.startConnectionRequest({
            ...input,
            target,
            owner: "local-admin",
            signal: context.req.raw.signal,
          }),
        );
      } catch (error) {
        if (
          error instanceof OAuthClientConfigError ||
          error instanceof OAuthFlowError ||
          error instanceof ConnectionError
        )
          return jsonError(
            context,
            error.code === "unknown_service" || error.code === "app_not_found" ? 404 : 400,
            error.code,
            error.message,
          );
        throw error;
      }
    });
    app.post("/api/oauth/authorizations", (context) => this.createOAuthAuthorization(context));
    app.get("/oauth/callback", (context) => this.completeOAuth(context));
    app.post("/mcp", (context) => this.handleMcp(context));
    app.get("/mcp", (context) => this.rejectMcpMethod(context));
    app.delete("/mcp", (context) => this.rejectMcpMethod(context));
    app.get("/mcp/tools", async (context) =>
      context.json({ tools: (await loadMcpModule()).listMcpToolSummaries(Boolean(this.options.approvals)) }),
    );

    // Without a console the API owns every unknown path; a console host layers its fallback over these 404s.
    if (this.options.registerStaticRoutes) this.options.registerStaticRoutes(app);
    else app.notFound(notFound);
    app.onError((error, context) => {
      if (error instanceof ProviderDispatchRequestError) {
        if (context.req.path.startsWith("/v1/"))
          return writeRuntimeFailure(context, {
            status: 429,
            errorCode: "rate_limited",
            message: error.message,
            data: toProviderExecutionError(error, error.message).error?.details,
          });
        const seconds = optionalRecord(error.details)?.retryAfterSeconds;
        if (typeof seconds === "number") context.header("Retry-After", String(seconds));
        return jsonError(context, 429, "rate_limited", error.message);
      }
      if (error instanceof SaasError) {
        this.options.logger?.warn(
          {
            method: context.req.method,
            path: context.req.path,
            code: error.code,
            status: error.status,
            reason: error.message,
          },
          "SaaS request failed",
        );
        if (error.retryAfter) context.header("Retry-After", error.retryAfter);
        if (context.req.path.startsWith("/v1/"))
          return writeRuntimeFailure(context, { status: error.status, errorCode: error.code, message: error.message });
        return context.json(
          { error: { code: error.code, message: error.message, reason: error.reason } },
          error.status,
        );
      }
      if (error instanceof HttpRequestError) {
        if (context.req.path.startsWith("/v1/")) {
          return writeRuntimeFailure(context, {
            status: error.status,
            errorCode: error.code,
            message: error.message,
          });
        }
        return jsonError(context, error.status, error.code, error.message);
      }
      this.options.logger?.error(
        {
          err: error,
          method: context.req.method,
          path: context.req.path,
        },
        "request failed",
      );
      if (context.req.path.startsWith("/v1/")) {
        return writeRuntimeFailure(context, {
          status: 500,
          errorCode: "internal_error",
          message: "Internal server error.",
        });
      }
      return internalError(context, error);
    });

    return app;
  }

  private async listProviderSummaries(context: Context): Promise<Response> {
    if (this.options.fetchProvidersAsset) {
      const response = await this.options.fetchProvidersAsset(context.req.raw);
      // Same missing-asset detection as /api/actions: the SPA fallback answers
      // unknown paths with the shell HTML, so a non-JSON response means the
      // deploy predates provider-summaries.json — use the in-memory payload.
      const contentType = response.headers.get("content-type") ?? "";
      if (response.ok && contentType.includes("json")) {
        return response;
      }
    }
    const { providerSummariesJson, providerSummariesEtag } = this.options.catalog;
    context.header("ETag", providerSummariesEtag);
    if (requestMatchesEtag(context.req.header("If-None-Match"), providerSummariesEtag)) {
      return context.body(null, 304);
    }
    return context.body(providerSummariesJson, 200, { "Content-Type": "application/json" });
  }

  /**
   * `/api/actions` serves the precomputed catalog byte string instead of
   * re-serializing `catalog.actions` — the ~40MB stringify + gzip per request
   * was the Worker CPU-limit 503 seen on the console overview.
   */
  private async listActions(context: Context): Promise<Response> {
    if (this.options.fetchActionsAsset) {
      const response = await this.options.fetchActionsAsset(context.req.raw);
      // `not_found_handling: "single-page-application"` answers a missing
      // asset with the shell HTML, so a non-JSON response means the deploy
      // predates catalog/actions.json — fall back to the in-memory payload.
      const contentType = response.headers.get("content-type") ?? "";
      if (response.ok && contentType.includes("json")) {
        return response;
      }
    }
    const { json, etag } = this.options.catalog.actionsPayload();
    context.header("ETag", etag);
    if (requestMatchesEtag(context.req.header("If-None-Match"), etag)) {
      return context.body(null, 304);
    }
    return context.body(json, 200, { "Content-Type": "application/json" });
  }

  private async configureMarketplace(context: Context): Promise<Response> {
    const body = await readJsonBody(context);
    const input: MarketplaceConfigInput = {
      discoveryUrl: optionalString(body.discoveryUrl),
      apiKey: optionalString(body.apiKey),
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    };
    try {
      return context.json(await this.options.marketplace!.configure(input));
    } catch (error) {
      if (error instanceof MarketplaceError) return this.writeMarketplaceError(context, error);
      throw error;
    }
  }

  private async getMarketplaceDiscovery(context: Context): Promise<Response> {
    try {
      return context.json(await this.options.marketplace!.getDefaultDiscovery(context.req.raw.signal));
    } catch (error) {
      if (error instanceof MarketplaceError) return this.writeMarketplaceError(context, error);
      throw error;
    }
  }

  private writeMarketplaceError(context: Context, error: MarketplaceError): Response {
    const status = error.status;
    return jsonError(
      context,
      status === 401 || status === 403 || status === 404 || status === 502 || status === 504 ? status : 400,
      error.code,
      error.message,
    );
  }

  private async deleteMarketplace(context: Context): Promise<Response> {
    await this.options.marketplace!.remove();
    return context.json(this.options.marketplace!.getState());
  }

  private async updateProviderPreference(context: Context, service: string): Promise<Response> {
    const body = await readJsonBody(context);
    if (typeof body.enabled !== "boolean") {
      return jsonError(context, 400, "invalid_input", "enabled must be a boolean.");
    }
    try {
      return context.json(await this.options.marketplace!.setProviderEnabled(service, body.enabled));
    } catch (error) {
      if (error instanceof MarketplaceError) return jsonError(context, 404, error.code, error.message);
      throw error;
    }
  }

  private async getRuntimeProviderSetup(context: Context, service: string): Promise<Response> {
    const provider = this.options.catalog.providers.find((provider) => provider.service === service);
    if (!provider) return writeRuntimeFailure(context, unknownServiceFailure(service));
    let oauth = provider.auth.some((auth) => auth.type === "oauth2")
      ? await this.options.oauthClientConfigs.getSummary(service)
      : undefined;
    const source = oauth ? await this.options.saasProject?.getSource(service) : undefined;
    if (oauth && source?.mode === "saas") {
      const { config } = await this.options.saasProject!.resolveConfig(
        service,
        source.providerConfigId,
        source.managedProjectId,
        context.req.raw.signal,
      );
      oauth = {
        ...oauth,
        configured: true,
        customClientAvailable: false,
        expectedRedirectUri: config.callbackUrl,
        missingFields: [],
      };
    }
    return writeRuntimeSuccess(context, serializeRuntimeProviderSetup(provider, oauth));
  }

  private getProvider(context: Context, service: string): Response {
    const provider = this.options.catalog.providers.find((provider) => provider.service === service);
    if (!provider) {
      return notFound(context);
    }

    return context.json(provider);
  }

  private async createTransitFile(context: Context): Promise<Response> {
    try {
      if (this.options.uploadTransitFile) {
        return context.json(await this.options.uploadTransitFile(context.req.raw));
      }

      const form = await context.req.raw.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return jsonError(context, 400, "invalid_input", "file is required.");
      }
      const upload = await this.options.transitFiles.create(file);
      return context.json(upload);
    } catch (error) {
      return this.handleTransitFileError(context, error);
    }
  }

  private async getTransitFile(context: Context, fileId: string): Promise<Response> {
    try {
      return await this.options.transitFiles.response(fileId);
    } catch (error) {
      return this.handleTransitFileError(context, error);
    }
  }

  private async deleteTransitFile(context: Context, fileId: string): Promise<Response> {
    try {
      const deleted = await this.options.transitFiles.delete(fileId);
      return context.json({ fileId, deleted });
    } catch (error) {
      return this.handleTransitFileError(context, error);
    }
  }

  private handleTransitFileError(context: Context, error: unknown): Response {
    if (error instanceof TransitFileError) {
      return jsonError(context, error.status, error.code, error.message);
    }
    throw error;
  }

  private getAction(context: Context, actionId: string): Response {
    const action = this.options.catalog.actionsById.get(actionId);
    if (!action) {
      return notFound(context);
    }

    return context.json(action);
  }

  private async listRuns(context: Context): Promise<Response> {
    const query = readRunLogListInput(context);
    if (!query.ok) {
      return jsonError(context, 400, "invalid_input", query.message);
    }

    return context.json(await this.options.actions.listRuns(query.input));
  }

  private async getRun(context: Context, id: string): Promise<Response> {
    const run = await this.options.actions.getRun(id);
    return run ? context.json(run) : jsonError(context, 404, "run_not_found", `Run not found: ${id}.`);
  }

  private async searchApiActions(context: Context): Promise<Response> {
    const query = readSearchQuery(context);
    if (!query.ok) {
      return jsonError(context, 400, "invalid_input", query.message);
    }

    const index = await this.actionSearch.get();
    return context.json(
      await this.serializeSearchResults(
        searchActions(index, query.q, {
          service: query.service,
          limit: query.limit,
        }),
      ),
    );
  }

  private async getActionMarkdown(context: Context, actionId: string): Promise<Response> {
    const action = this.options.catalog.actionsById.get(actionId);
    if (!action) {
      return notFound(context);
    }

    try {
      const policy = (await this.getPolicySnapshot(context)).evaluate(action);
      return context.text(
        renderActionMarkdown(action, {
          transport: { kind: "http", origin: this.options.publicOrigin },
          connection: await this.options.connections.getConnectionSummary(action.service, readConnectionName(context)),
          policy,
        }),
        200,
        {
          "content-type": "text/markdown; charset=utf-8",
        },
      );
    } catch (error) {
      if (error instanceof ConnectionError) {
        const status = mapConnectionErrorStatus(error);
        return jsonError(context, status, error.code, error.message);
      }
      throw error;
    }
  }

  private listRuntimeProviders(context: Context): Response {
    const services = context.req.queries("service") ?? [];
    const query = optionalString(context.req.query("q"))?.toLowerCase();
    const providers = this.options.catalog.providers.filter((provider) => {
      if (services.length > 0 && !services.includes(provider.service)) {
        return false;
      }
      if (!query) {
        return true;
      }

      return [
        provider.service,
        provider.displayName,
        provider.categories.join(" "),
        provider.scenario,
        provider.authTypes.join(" "),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    return writeRuntimeSuccess(context, providers.map(serializeRuntimeProvider));
  }

  private listRuntimeActions(context: Context): Response {
    const service = optionalString(context.req.query("service"));
    if (!service) {
      const services = [...new Set(this.options.catalog.actions.map((action) => action.service))];
      return writeRuntimeSuccess(context, services.map(serializeRuntimeActionService));
    }

    const actions = this.options.catalog.actions.filter((action) => action.service === service);
    return writeRuntimeSuccess(context, actions.map(serializeRuntimeAction));
  }

  private async searchRuntimeActions(context: Context): Promise<Response> {
    const query = readSearchQuery(context, 10);
    if (!query.ok) {
      return writeRuntimeFailure(context, {
        status: 400,
        errorCode: "invalid_input",
        message: query.message,
      });
    }

    const index = await this.actionSearch.get();
    const results = searchActions(index, query.q, {
      service: query.service,
      limit: query.limit,
    });
    return writeRuntimeSuccess(context, await this.serializeSearchResults(results));
  }

  private async serializeSearchResults(results: ActionSearchDocument[]): Promise<RuntimeActionSearchResult[]> {
    const authenticated = new Set(
      await this.options.connections.listAuthenticatedServices([...new Set(results.map((result) => result.service))]),
    );
    return results.flatMap((result) => {
      const action = this.options.catalog.actionsById.get(result.id);
      if (!action) {
        return [];
      }
      return [serializeActionSearchResult(result, action, authenticated.has(action.service))];
    });
  }

  private getRuntimeAction(context: Context, actionId: string): Response {
    const action = this.options.catalog.actionsById.get(actionId);
    if (!action) {
      return writeRuntimeFailure(context, unknownActionFailure(actionId));
    }

    return writeRuntimeSuccess(context, serializeRuntimeAction(action));
  }

  private async getRuntimeTriggerPermissions(context: Context, service: string): Promise<Response> {
    const provider = this.options.catalog.providers.find((item) => item.service === service);
    if (!provider) throw new HttpRequestError("provider_not_found", "Provider not found.", 404);
    return writeRuntimeSuccess(context, serializeRuntimeTriggerPermissions(provider));
  }

  private async executeRuntimeTrigger(context: Context): Promise<Response> {
    if (!this.options.triggers)
      throw new HttpRequestError("trigger_not_supported", "Trigger execution is unavailable.", 501);
    const { readTriggerRequest } = await import("../triggers/request.ts");
    const request = readTriggerRequest(await readJsonBody(context, 160 * 1024));
    const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(45_000)]);
    const result = await this.options.triggers.run({
      service: context.req.param("service")!,
      triggerId: context.req.param("triggerId")!,
      request,
      connectionName: readConnectionName(context),
      connectionId: optionalString(context.req.header("x-oo-connector-app-id")),
      policy: await this.getPolicySnapshot(context),
      grant: readRuntimeGrant(context),
      signal,
    });
    return writeRuntimeSuccess(context, result);
  }

  private async createRuntimeActionRun(context: Context, actionId: string): Promise<Response> {
    const action = this.options.catalog.actionsById.get(actionId);
    if (!action) {
      return writeRuntimeFailure(context, unknownActionFailure(actionId));
    }

    const body = await readJsonBody(context);
    const input = body.input ?? {};
    const connectionName = readConnectionName(context, body);
    const connectionId = optionalString(context.req.header("x-oo-connector-app-id"));
    const runtimeGrant = readRuntimeGrant(context);
    let policy: ActionPolicySnapshot;
    try {
      policy = await this.getPolicySnapshot(context);
    } catch {
      return writeRuntimeFailure(context, {
        status: 500,
        errorCode: "internal_error",
        message: "Runtime policy is unavailable.",
        meta: { actionId },
      });
    }
    if (!policy.evaluate(action).allowed) {
      return writeRuntimeActionHttpResult(
        context,
        await this.executeRuntimeAction(
          actionId,
          input,
          connectionName,
          policy,
          runtimeGrant?.tokenId,
          context.req.raw.signal,
          connectionId,
        ),
      );
    }
    const idempotencyKey = readIdempotencyKey(context.req.header("idempotency-key"));
    if (!idempotencyKey.ok) {
      return writeRuntimeFailure(context, {
        status: 400,
        errorCode: "invalid_input",
        message: idempotencyKey.message,
        meta: { actionId },
      });
    }

    if (!idempotencyKey.key) {
      return writeRuntimeActionHttpResult(
        context,
        await this.executeRuntimeAction(
          actionId,
          input,
          connectionName,
          policy,
          runtimeGrant?.tokenId,
          context.req.raw.signal,
          connectionId,
          this.createApprovalGate(context),
        ),
      );
    }

    const now = new Date();
    const keyHash = hashIdempotencyKey(idempotencyKey.key);
    let requestHash: string;
    try {
      requestHash = hashActionRequest({
        actionId,
        connectionName: connectionName ?? defaultConnectionName,
        connectionId,
        input,
        runtimeTokenId: runtimeGrant?.tokenId,
      });
    } catch (error) {
      if (!(error instanceof ActionInputDepthError)) {
        throw error;
      }
      return writeRuntimeFailure(context, {
        status: 400,
        errorCode: "invalid_input",
        message: error.message,
        meta: { actionId },
      });
    }
    const claimId = crypto.randomUUID();
    const claim = await this.options.idempotency.claim({
      keyHash,
      requestHash,
      claimId,
      now: now.toISOString(),
      expiresAt: createIdempotencyExpiry(now),
    });

    if (claim.kind === "conflict") {
      return writeRuntimeFailure(context, {
        status: 409,
        errorCode: "idempotency_key_conflict",
        message: "Idempotency-Key has already been used with a different request.",
        meta: { actionId },
      });
    }
    if (claim.kind === "in_progress") {
      return writeRuntimeFailure(context, {
        status: 409,
        errorCode: "idempotency_request_in_progress",
        message: "A request with this Idempotency-Key is still in progress.",
        meta: { actionId },
      });
    }
    if (claim.kind === "completed") {
      return writeRuntimeActionHttpResult(context, claim.response);
    }

    const result = await this.executeRuntimeAction(
      actionId,
      input,
      connectionName,
      policy,
      runtimeGrant?.tokenId,
      context.req.raw.signal,
      connectionId,
      this.createApprovalGate(context),
    );
    const completed = await this.options.idempotency.complete({
      keyHash,
      requestHash,
      claimId,
      response: result,
      expiresAt: createIdempotencyExpiry(new Date()),
    });
    if (!completed) {
      throw new Error("Idempotency claim was replaced before completion.");
    }

    return writeRuntimeActionHttpResult(context, result);
  }

  private async executeRuntimeAction(
    actionId: string,
    input: unknown,
    connectionName: string | undefined,
    policy: ActionPolicySnapshot,
    runtimeTokenId: string | undefined,
    signal: AbortSignal | undefined,
    connectionId?: string,
    approvalGate?: ApprovalGate,
    approvalId?: string,
  ): Promise<RuntimeActionHttpResult> {
    try {
      const run = await this.options.actions.run({
        actionId,
        input,
        caller: "http",
        connectionName,
        connectionId,
        policy,
        runtimeTokenId,
        signal,
        approvalGate,
        bypassApproval: approvalId !== undefined,
        approvalId,
      });
      if (!run) {
        return serializeRuntimeFailure(unknownActionFailure(actionId));
      }

      if (run.approval?.interception) {
        const record = run.approval.interception.approval;
        return serializeRuntimeFailure({
          status: 202,
          errorCode: "approval_required",
          message: "Action requires approval before execution.",
          data: this.approvalRequiredData(record),
          meta: { actionId, executionId: run.executionId, approvalId: record.id },
        });
      }

      const httpResult = serializeRuntimeActionResult({
        actionId,
        executionId: run.executionId,
        remoteExecutionId: run.remoteExecutionId,
        failureStatus: run.failureStatus,
        retryAfter: run.retryAfter,
        auditPersisted: run.auditPersisted,
        result: run.result,
      });
      if (approvalId) {
        httpResult.body.meta = { ...httpResult.body.meta, approvalId };
      }
      return httpResult;
    } catch (error) {
      if (error instanceof ConnectionError) {
        return serializeRuntimeFailure({
          status: mapConnectionErrorStatus(error),
          errorCode: error.code,
          message: error.message,
          meta: { actionId },
        });
      }

      throw error;
    }
  }

  private async createRuntimeProxyRequest(context: Context, service: string): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(context);
    } catch (error) {
      if (error instanceof HttpRequestError) {
        return writeRuntimeFailure(context, {
          status: error.status,
          errorCode: error.code,
          message: error.message,
          meta: { service },
        });
      }

      throw error;
    }

    let policy: ActionPolicySnapshot;
    try {
      policy = await this.getPolicySnapshot(context);
    } catch {
      return writeRuntimeFailure(context, {
        status: 500,
        errorCode: "internal_error",
        message: "Runtime policy is unavailable.",
        meta: { service },
      });
    }
    const result = await this.proxyRunner.run({
      service,
      input: body,
      connectionName: readConnectionName(context, body),
      connectionId: optionalString(context.req.header("x-oo-connector-app-id")),
      policy,
      signal: context.req.raw.signal,
      approvalGate: this.createApprovalGate(context),
    });
    if (result.ok) {
      return writeRuntimeSuccess(context, result.response, result.meta);
    }

    return writeRuntimeFailure(context, {
      status: result.status,
      errorCode: result.errorCode,
      message: result.message,
      data: result.approval ? this.approvalRequiredData(result.approval.interception.approval) : result.data,
      meta: result.approval ? { ...result.meta, approvalId: result.approval.interception.approval.id } : result.meta,
    });
  }

  /**
   * Per-request approval gate handed to the runners: binds this caller's
   * runtime token (grant consumption stays per-token) and owner key (approval
   * records stay creator-scoped), and fingerprints the request for pending
   * dedupe. The stored preview runs through `summarizeForRunLog`, the stored
   * payload through the secret codec.
   */
  private createApprovalGate(context: Context): ApprovalGate | undefined {
    const service = this.options.approvals;
    if (!service) {
      return undefined;
    }
    const grant = readRuntimeGrant(context);
    return {
      lookup: service.createGrantLookup(grant?.tokenId),
      requireApproval: async (request: ApprovalGateRequest) => {
        const requestFingerprint = hashApprovalRequestFingerprint(request, grant?.tokenId);
        const result = await service.requireApproval({
          kind: request.kind,
          ownerKey: service.readOwnerKey(context),
          runtimeTokenId: grant?.tokenId,
          actionId: request.actionId,
          service: request.service,
          connectionId: request.request.connectionId,
          connectionName: request.request.connectionName,
          operationType: request.operationType,
          caller: request.caller,
          request: request.request,
          requestFingerprint,
          preview: summarizeForRunLog(request.request.input),
        });
        return { approval: result.approval, created: result.created };
      },
    };
  }

  /** `/v1` data block for `approval_required` and the pending poll payload. */
  private approvalRequiredData(record: ApprovalRecord): Record<string, unknown> {
    return {
      approvalId: record.id,
      pollUrl: `/v1/approvals/${record.id}`,
      approvalUrl: `${this.options.publicOrigin}/approvals/${record.id}`,
      operationType: record.operationType,
      expiresAt: record.expiresAt,
      preview: record.preview,
    };
  }

  /**
   * `GET /v1/approvals/:id` — the creator's poll. Execution runs here on the
   * first poll after approval, never on the approve call; the stored request
   * is re-evaluated against the caller's then-current policy. Completed
   * executions replay through the idempotency store keyed `approval:<id>`.
   */
  private async pollRuntimeApproval(context: Context, approvalId: string): Promise<Response> {
    const service = this.options.approvals!;
    const ownerKey = service.readOwnerKey(context);
    const outcome = await service.poll(approvalId, ownerKey);
    if (outcome.kind === "not_found") {
      return writeRuntimeFailure(context, {
        status: 404,
        errorCode: "approval_not_found",
        message: `Approval not found: ${approvalId}.`,
      });
    }
    if (outcome.kind === "rate_limited") {
      context.header("Retry-After", String(approvalPollIntervalSeconds));
      return writeRuntimeFailure(context, {
        status: 429,
        errorCode: "rate_limited",
        message: "Approval was polled faster than the Retry-After interval.",
        meta: { approvalId },
      });
    }
    if (outcome.kind === "pending" || outcome.kind === "in_flight") {
      context.header("Retry-After", String(approvalPollIntervalSeconds));
      return writeRuntimeFailure(context, {
        status: 202,
        errorCode: "approval_required",
        message: outcome.kind === "in_flight" ? "Approval is executing." : "Approval is still pending.",
        data: {
          ...this.approvalRequiredData(outcome.approval),
          status: outcome.kind === "in_flight" ? "executing" : "pending",
        },
      });
    }
    const record = outcome.approval;
    if (outcome.kind === "terminal") {
      if (record.status === "denied") {
        return writeRuntimeFailure(context, {
          status: 403,
          errorCode: "approval_denied",
          message: "Approval was denied.",
          meta: { approvalId, decidedAt: record.decidedAt },
        });
      }
      if (record.status === "expired") {
        return writeRuntimeFailure(context, {
          status: 410,
          errorCode: "approval_expired",
          message: "Approval expired before it was decided.",
          meta: { approvalId, expiresAt: record.expiresAt },
        });
      }
      // executed | failed: replay the stored response.
      const replay = await this.claimApprovalReplay(record);
      if (replay) {
        return writeRuntimeActionHttpResult(context, replay);
      }
      return writeRuntimeFailure(context, {
        status: 500,
        errorCode: "internal_error",
        message: "Approval execution result is no longer stored.",
        meta: { approvalId },
      });
    }

    // approved: this poll claims and runs the stored request once.
    const claimed = await service.beginExecution(record.id);
    if (!claimed) {
      context.header("Retry-After", String(approvalPollIntervalSeconds));
      return writeRuntimeFailure(context, {
        status: 202,
        errorCode: "approval_required",
        message: "Approval is executing.",
        data: { ...this.approvalRequiredData(record), status: "executing" },
      });
    }
    const result = await this.executeApprovedApproval(context, claimed);
    return writeRuntimeActionHttpResult(context, result);
  }

  /**
   * Replay path for `executed`/`failed` records: the response was stored under
   * `approval:<id>` when the run completed. A claim hit returns the stored
   * envelope unchanged.
   */
  private async claimApprovalReplay(record: ApprovalRecord): Promise<RuntimeActionHttpResult | undefined> {
    const claim = await this.options.idempotency.claim({
      keyHash: hashIdempotencyKey(`approval:${record.id}`),
      requestHash: record.requestFingerprint,
      claimId: crypto.randomUUID(),
      now: new Date().toISOString(),
      expiresAt: createIdempotencyExpiry(new Date()),
    });
    if (claim.kind === "completed") {
      return claim.response;
    }
    return undefined;
  }

  /**
   * MCP `get_approval`: the same poll semantics as `GET /v1/approvals/:id`
   * (creator-scoped, execute-on-first-poll) projected onto tool payloads
   * instead of HTTP envelopes.
   */
  private async pollApprovalForTool(
    context: Context,
    query: { approvalId?: string; connectionRequestId?: string },
  ): Promise<Record<string, unknown>> {
    const service = this.options.approvals!;
    const ownerKey = service.readOwnerKey(context);
    let record: ApprovalRecord | undefined;
    if (query.approvalId) {
      record = await service.get(query.approvalId);
    } else if (query.connectionRequestId) {
      record = await service.getForConnectionRequest(query.connectionRequestId, ownerKey);
    }
    if (!record || record.ownerKey !== ownerKey) {
      return { ok: false, error: { code: "approval_not_found", message: "Approval not found." } };
    }
    const outcome = await service.poll(record.id, ownerKey);
    const approvalUrl = `${this.options.publicOrigin}/approvals/${record.id}`;
    switch (outcome.kind) {
      case "not_found":
        return { ok: false, error: { code: "approval_not_found", message: "Approval not found." } };
      case "rate_limited":
        return {
          ok: false,
          error: { code: "rate_limited", message: "Approval was polled faster than the Retry-After interval." },
        };
      case "pending":
        return {
          ok: true,
          data: {
            status: "pending",
            approvalId: record.id,
            approvalUrl,
            expiresAt: outcome.approval.expiresAt,
          },
        };
      case "in_flight":
        return { ok: true, data: { status: "executing", approvalId: record.id, approvalUrl } };
      case "terminal": {
        if (outcome.approval.status === "denied") {
          return { ok: false, error: { code: "approval_denied", message: "Approval was denied." } };
        }
        if (outcome.approval.status === "expired") {
          return { ok: false, error: { code: "approval_expired", message: "Approval expired before it was decided." } };
        }
        const replay = await this.claimApprovalReplay(outcome.approval);
        if (!replay) {
          return {
            ok: false,
            error: { code: "internal_error", message: "Approval execution result is no longer stored." },
          };
        }
        return approvalResultToolPayload(replay);
      }
      case "approved": {
        const claimed = await service.beginExecution(record.id);
        if (!claimed) {
          return { ok: true, data: { status: "executing", approvalId: record.id, approvalUrl } };
        }
        return approvalResultToolPayload(await this.executeApprovedApproval(context, claimed));
      }
    }
  }

  /**
   * Runs the stored request under the caller's now-current policy, persists the
   * response for replay, and settles the record to `executed`/`failed`.
   */
  private async executeApprovedApproval(context: Context, record: ApprovalRecord): Promise<RuntimeActionHttpResult> {
    const service = this.options.approvals!;
    const claimId = crypto.randomUUID();
    const keyHash = hashIdempotencyKey(`approval:${record.id}`);
    const finish = async (
      status: "executed" | "failed",
      executionId: string | undefined,
      result: RuntimeActionHttpResult,
    ) => {
      const completed = await this.options.idempotency.complete({
        keyHash,
        requestHash: record.requestFingerprint,
        claimId,
        response: result,
        expiresAt: createIdempotencyExpiry(new Date()),
      });
      if (!completed) {
        this.options.logger?.warn({ approvalId: record.id }, "approval idempotency completion lost");
      }
      await service.finishExecution(record.id, status, executionId);
      return result;
    };

    // The idempotency claim serializes concurrent execute attempts.
    const claim = await this.options.idempotency.claim({
      keyHash,
      requestHash: record.requestFingerprint,
      claimId,
      now: new Date().toISOString(),
      expiresAt: createIdempotencyExpiry(new Date()),
    });
    if (claim.kind === "completed") {
      await service.finishExecution(record.id, "executed", record.executionId);
      return claim.response;
    }
    if (claim.kind !== "acquired") {
      await service.releaseExecution(record.id);
      return serializeRuntimeFailure({
        status: 202,
        errorCode: "approval_required",
        message: "Approval is executing.",
        data: { ...this.approvalRequiredData(record), status: "executing" },
      });
    }

    const stored = await service.readStoredRequest(record.id);
    if (!stored) {
      return await finish(
        "failed",
        undefined,
        serializeRuntimeFailure({
          status: 500,
          errorCode: "internal_error",
          message: "Approval request payload is no longer stored.",
          meta: { approvalId: record.id },
        }),
      );
    }

    let policy: ActionPolicySnapshot;
    try {
      policy = await this.getPolicySnapshot(context);
    } catch {
      return await finish(
        "failed",
        undefined,
        serializeRuntimeFailure({
          status: 500,
          errorCode: "internal_error",
          message: "Runtime policy is unavailable.",
          meta: { approvalId: record.id },
        }),
      );
    }

    try {
      if (record.kind === "proxy") {
        const result = await this.proxyRunner.run({
          service: record.service,
          input: stored.input,
          connectionName: stored.connectionName,
          connectionId: stored.connectionId,
          policy,
          signal: context.req.raw.signal,
          bypassApproval: true,
        });
        const httpResult: RuntimeActionHttpResult = result.ok
          ? {
              status: 200,
              body: {
                success: true,
                message: "OK",
                data: result.response,
                meta: { ...(result.meta ?? {}), approvalId: record.id },
              },
            }
          : {
              status: result.status,
              body: {
                success: false,
                message: result.message,
                data: result.data ?? null,
                errorCode: result.errorCode,
                meta: { ...(result.meta ?? {}), approvalId: record.id },
              },
            };
        return await finish(result.ok ? "executed" : "failed", optionalString(result.meta?.executionId), httpResult);
      }
      const result = await this.executeRuntimeAction(
        record.actionId,
        stored.input,
        stored.connectionName,
        policy,
        record.runtimeTokenId,
        context.req.raw.signal,
        stored.connectionId,
        this.createApprovalGate(context),
        record.id,
      );
      return await finish(
        result.status === 200 ? "executed" : "failed",
        optionalString(result.body.meta.executionId),
        result,
      );
    } catch (error) {
      this.options.logger?.warn({ approvalId: record.id, err: error }, "approval execution failed");
      return await finish(
        "failed",
        undefined,
        serializeRuntimeFailure({
          status: 500,
          errorCode: "internal_error",
          message: "Approval execution failed unexpectedly.",
          meta: { approvalId: record.id },
        }),
      );
    }
  }

  private async listApprovals(context: Context): Promise<Response> {
    const service = this.options.approvals!;
    const page = await service.list({
      status: context.req.query("status"),
      cursor: context.req.query("cursor") || undefined,
    });
    return context.json({
      items: page.items.map((record) => serializeAdminApproval(record)),
      nextCursor: page.nextCursor,
    });
  }

  private async getApproval(context: Context, id: string): Promise<Response> {
    const record = await this.options.approvals!.get(id);
    if (!record) {
      return jsonError(context, 404, "approval_not_found", `Approval not found: ${id}.`);
    }
    return context.json(serializeAdminApproval(record));
  }

  private async decideApproval(context: Context, id: string, decision: "approve" | "deny"): Promise<Response> {
    const service = this.options.approvals!;
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(context, 16_384);
    } catch (error) {
      if (error instanceof HttpRequestError) {
        return jsonError(context, error.status, error.code, error.message);
      }
      throw error;
    }
    const grantInput = decision === "approve" ? readCreateGrantInput(body.grant) : undefined;
    if (typeof grantInput === "string") {
      return jsonError(context, 400, "invalid_input", grantInput);
    }
    try {
      const outcome = await service.decide(
        id,
        decision,
        {
          decidedBy: hasAdminBearer(context) ? "admin" : "admin_session",
          decisionFactor: hasAdminBearer(context) ? "admin" : "admin_session",
          decisionReason: optionalString(body.reason),
        },
        grantInput,
      );
      if (outcome.kind === "not_found") {
        return jsonError(context, 404, "approval_not_found", `Approval not found: ${id}.`);
      }
      if (outcome.kind === "conflict") {
        return context.json(
          {
            error: "approval_decided",
            message: "Approval was already decided.",
            approval: serializeAdminApproval(outcome.approval),
          },
          409,
        );
      }
      return context.json({
        approval: serializeAdminApproval(outcome.approval),
        grant: outcome.kind === "approved" ? outcome.grant : undefined,
      });
    } catch (error) {
      if (error instanceof ApprovalRequestError) {
        return jsonError(context, 400, "invalid_input", error.message);
      }
      throw error;
    }
  }

  private async listApprovalGrants(context: Context): Promise<Response> {
    const grants = await this.options.approvals!.listGrants();
    return context.json({ items: grants.map(serializeApprovalGrant) });
  }

  private async deleteApprovalGrant(context: Context, id: string): Promise<Response> {
    const deleted = await this.options.approvals!.deleteGrant(id);
    if (!deleted) {
      return jsonError(context, 404, "grant_not_found", `Approval grant not found: ${id}.`);
    }
    return context.json({ ok: true });
  }

  private async listRuntimeApps(context: Context): Promise<Response> {
    let policy: ActionPolicySnapshot;
    try {
      policy = await this.getPolicySnapshot(context);
    } catch {
      return writeRuntimeFailure(context, {
        status: 500,
        errorCode: "internal_error",
        message: "Runtime policy is unavailable.",
      });
    }
    return writeRuntimeSuccess(
      context,
      this.filterAllowedConnections(policy, await this.options.connections.listConnections()).map(
        serializeRuntimeConnectedApp,
      ),
    );
  }

  private async listRuntimeAppsByService(context: Context, service: string): Promise<Response> {
    let policy: ActionPolicySnapshot;
    try {
      policy = await this.getPolicySnapshot(context);
    } catch {
      return writeRuntimeFailure(context, {
        status: 500,
        errorCode: "internal_error",
        message: "Runtime policy is unavailable.",
        meta: { service },
      });
    }
    try {
      return writeRuntimeSuccess(
        context,
        this.filterAllowedConnections(policy, await this.options.connections.listConnectionsByService(service)).map(
          serializeRuntimeConnectedApp,
        ),
      );
    } catch (error) {
      if (error instanceof ConnectionError) {
        return writeRuntimeFailure(context, {
          status: mapConnectionErrorStatus(error),
          errorCode: error.code,
          message: error.message,
          meta: { service },
        });
      }

      throw error;
    }
  }

  private async listAuthenticatedRuntimeApps(context: Context): Promise<Response> {
    const services = context.req.queries("service") ?? [];
    let policy: ActionPolicySnapshot;
    try {
      policy = await this.getPolicySnapshot(context);
    } catch {
      return writeRuntimeFailure(context, {
        status: 500,
        errorCode: "internal_error",
        message: "Runtime policy is unavailable.",
      });
    }
    const authenticated = new Set(
      this.filterAllowedConnections(policy, await this.options.connections.listConnections())
        .filter((connection) => connection.configured && connection.authType !== "no_auth")
        .map((connection) => connection.service),
    );
    return writeRuntimeSuccess(
      context,
      services.filter((service) => authenticated.has(service)),
    );
  }

  private filterAllowedConnections(
    policy: ActionPolicySnapshot,
    connections: ConnectionSummary[],
  ): ConnectionSummary[] {
    return connections.filter(
      (connection) => connection.authType === "no_auth" || policy.evaluateConnection(connection.id).allowed,
    );
  }

  private async handleMcp(context: Context): Promise<Response> {
    const { handleMcpRequest } = await loadMcpModule();
    return await handleMcpRequest(context.req.raw, {
      catalog: this.options.catalog,
      connections: this.options.connections,
      actions: this.options.actions,
      actionSearch: this.actionSearch,
      getPolicySnapshot: () => this.getPolicySnapshot(context),
      runtimeGrant: readRuntimeGrant(context),
      publicOrigin: this.options.publicOrigin,
      approvalGate: this.createApprovalGate(context),
      pollApproval: this.options.approvals ? (query) => this.pollApprovalForTool(context, query) : undefined,
      signal: context.req.raw.signal,
    });
  }

  private rejectMcpMethod(context: Context): Response {
    return context.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed.",
        },
        id: null,
      },
      405,
    );
  }

  private async listConnections(context: Context): Promise<Response> {
    return context.json(await this.options.connections.listConnections());
  }

  private async upsertConnection(context: Context, service: string): Promise<Response> {
    const body = await readJsonBody(context);
    const authType = optionalString(body.authType);
    if (!authType) {
      this.options.logger?.warn(
        {
          errorCode: "invalid_input",
          path: context.req.path,
          service,
        },
        "connection rejected",
      );
      return jsonError(context, 400, "invalid_input", "authType is required.");
    }

    const values = body.values ?? body;
    const connectionName = readConnectionName(context, body);
    const logContext: ConnectionLogContext = {
      operation: "connect",
      path: context.req.path,
      service,
      authType,
      connectionName,
    };
    if (authType === "no_auth") {
      this.options.logger?.info(logContext, "connection started");
      return this.writeConnectionResult(
        context,
        this.options.connections.connectWithoutAuth(service, { connectionName }),
        logContext,
      );
    }
    if (authType === "api_key") {
      this.options.logger?.info(logContext, "connection started");
      return this.writeConnectionResult(
        context,
        this.options.connections.connectWithApiKey(service, {
          values,
          connectionName,
          signal: context.req.raw.signal,
        }),
        logContext,
      );
    }
    if (authType === "custom_credential") {
      this.options.logger?.info(logContext, "connection started");
      return this.writeConnectionResult(
        context,
        this.options.connections.connectWithCustomCredential(service, {
          values,
          connectionName,
          signal: context.req.raw.signal,
        }),
        logContext,
      );
    }

    this.options.logger?.warn(
      {
        ...logContext,
        errorCode: "unsupported_auth_type",
      },
      "connection rejected",
    );
    return jsonError(context, 400, "unsupported_auth_type", `${service} does not support ${authType}.`);
  }

  private async disconnect(context: Context, service: string): Promise<Response> {
    const body = await readJsonBody(context);
    const connectionName = readConnectionName(context, body);
    const logContext: ConnectionLogContext = {
      operation: "disconnect",
      path: context.req.path,
      service,
      connectionName,
    };
    this.options.logger?.info(logContext, "connection disconnect started");
    return this.writeConnectionResult(
      context,
      this.options.connections.disconnect(service, connectionName, { revoke: optionalBoolean(body.revoke) }),
      logContext,
    );
  }

  private async createOAuthAuthorization(context: Context): Promise<Response> {
    const body = await readJsonBody(context);
    const requestedService = optionalString(body.service);
    const connectionName = readConnectionName(context, body);
    try {
      const service = requiredString(
        body.service,
        "service",
        (message) => new OAuthFlowError("invalid_input", message),
      );
      const logContext = {
        path: context.req.path,
        service,
        connectionName,
      };
      this.options.logger?.info(logContext, "oauth authorization started");

      const authorization = await this.options.oauthFlow.startAuthorization({
        service,
        connectionName,
        clientConfig: readOAuthClientConfigInput(body),
        authorizationOptionIds: readOptionalStringArray(body, "authorizationOptionIds"),
      });
      const authorizationUrl = new URL(authorization.authorizationUrl);
      this.options.logger?.info(
        {
          ...logContext,
          authorizationHost: authorizationUrl.host,
          redirectUri: authorizationUrl.searchParams.get("redirect_uri") ?? undefined,
        },
        "oauth authorization created",
      );
      return context.json(authorization);
    } catch (error) {
      if (
        error instanceof OAuthClientConfigError ||
        error instanceof OAuthFlowError ||
        error instanceof ConnectionError
      ) {
        this.options.logger?.warn(
          {
            errorCode: error.code,
            path: context.req.path,
            service: requestedService,
            connectionName,
          },
          "oauth authorization failed",
        );
        const status = error.code === "unknown_service" ? 404 : 400;
        return jsonError(context, status, error.code, error.message);
      }

      throw error;
    }
  }

  private async listRuntimeTokens(context: Context): Promise<Response> {
    return context.json(await this.options.runtimeTokens.listTokens());
  }

  private async createRuntimeToken(context: Context): Promise<Response> {
    const body = await readJsonBody(context, policyRequestMaxBytes);
    const name = optionalString(body.name);
    if (!name) {
      return jsonError(context, 400, "invalid_input", "name is required.");
    }

    const created = await this.options.runtimeTokens.createToken(name, readTokenPolicy(body, true));
    return context.json({
      token: created.token,
      record: summarizeRuntimeToken(created.record),
    });
  }

  private async updateRuntimeToken(context: Context, id: string): Promise<Response> {
    const body = await readJsonBody(context, policyRequestMaxBytes);
    const token = await this.options.runtimeTokens.updateTokenPolicy(id, readTokenPolicy(body));
    return token
      ? context.json(token)
      : jsonError(context, 404, "runtime_token_not_found", `Runtime token not found: ${id}.`);
  }

  private async revokeRuntimeToken(context: Context, id: string): Promise<Response> {
    if (!(await this.options.runtimeTokens.revokeToken(id))) {
      return jsonError(context, 404, "runtime_token_not_found", `Runtime token not found: ${id}.`);
    }

    return context.json({ id, revoked: true });
  }

  private async getRuntimePolicy(context: Context): Promise<Response> {
    return context.json((await this.getPolicySnapshot(context)).state);
  }

  private async updateRuntimePolicy(context: Context): Promise<Response> {
    const body = await readJsonBody(context, policyRequestMaxBytes);
    const rules = readRuntimePolicyRules(body);
    const updatedAt = new Date().toISOString();
    await this.options.runtimePolicyStore.set({ rules, updatedAt });
    return context.json({
      deployment: this.actionPolicy.rules,
      runtime: rules,
      updatedAt,
    });
  }

  private async listOAuthConfigs(context: Context): Promise<Response> {
    const configs = await this.options.oauthClientConfigs.listConfigs();
    const sources = await this.options.saasProject?.listSources();
    return context.json(
      configs.map((config) => ({
        ...config,
        oauthSource: sources?.get(config.service) ?? { mode: "local" },
        customClientAvailable: sources?.has(config.service) ? false : config.customClientAvailable,
      })),
    );
  }

  private async upsertOAuthConfig(context: Context, service: string): Promise<Response> {
    const body = await readJsonBody(context);
    return this.writeOAuthResult(
      context,
      this.options.oauthClientConfigs.upsertConfig({
        service,
        clientId: optionalString(body.clientId) ?? "",
        clientSecret: optionalString(body.clientSecret) ?? "",
        requestedScopes: readOptionalStringArray(body, "requestedScopes"),
        redirectUri: readOptionalRawString(body, "redirectUri"),
        extra: optionalRecord(body.extra),
        secretExtra: optionalRecord(body.secretExtra),
      }),
    );
  }

  private async deleteOAuthConfig(context: Context, service: string): Promise<Response> {
    return this.writeOAuthResult(context, this.options.oauthClientConfigs.deleteConfig(service));
  }

  private async completeOAuth(context: Context): Promise<Response> {
    const state = context.req.query("state");
    const code = context.req.query("code");
    const logContext = {
      path: context.req.path,
      hasState: Boolean(state),
      hasCode: Boolean(code),
    };
    this.options.logger?.info(logContext, "oauth callback received");
    const providerError = context.req.query("error");
    if (providerError) {
      const returnUri = state
        ? await this.options.oauthFlow.rejectAuthorization(state, providerError === "access_denied")
        : undefined;
      if (returnUri) return context.redirect(returnUri);
      const providerErrorDescription = context.req.query("error_description");
      this.options.logger?.warn(
        {
          ...logContext,
          errorCode: "oauth_provider_error",
          providerError,
          providerErrorDescription,
        },
        "oauth callback failed",
      );
      return jsonError(
        context,
        400,
        "oauth_provider_error",
        `OAuth provider returned error "${providerError}"${providerErrorDescription ? `: ${providerErrorDescription}` : "."}`,
      );
    }
    if (!state || !code) {
      if (state) await this.options.oauthFlow.rejectAuthorization(state, false);
      this.options.logger?.warn(
        {
          ...logContext,
          errorCode: "invalid_oauth_callback",
        },
        "oauth callback failed",
      );
      return jsonError(context, 400, "invalid_oauth_callback", "OAuth callback requires state and code.");
    }

    let service: string;
    try {
      const completed = await this.options.oauthFlow.completeAuthorization({
        state,
        code,
        callbackParameters: Object.fromEntries(new URL(context.req.url).searchParams),
        signal: context.req.raw.signal,
      });
      service = completed.service;
      if (completed.returnUri) return context.redirect(completed.returnUri);
      this.options.logger?.info(
        {
          ...logContext,
          service,
        },
        "oauth callback completed",
      );
    } catch (error) {
      if (error instanceof OAuthCallbackError && error.returnUri) return context.redirect(error.returnUri);
      if (error instanceof OAuthFlowError || error instanceof ConnectionError) {
        const cancelled = error instanceof ConnectionError && error.code === "connection_cancelled";
        this.options.logger?.[cancelled ? "info" : "warn"](
          {
            ...logContext,
            errorCode: error.code,
          },
          cancelled ? "oauth callback cancelled" : "oauth callback failed",
        );
        return jsonError(context, error.code === "unknown_service" ? 404 : 400, error.code, error.message);
      }
      throw error;
    }

    return context.html(renderOAuthCompletionPage(service));
  }

  private async writeConnectionResult(
    context: Context,
    operation: Promise<unknown>,
    logContext?: ConnectionLogContext,
  ): Promise<Response> {
    try {
      const result = await operation;
      if (logContext) {
        this.options.logger?.info(
          logContext,
          logContext.operation === "disconnect" ? "connection disconnect completed" : "connection completed",
        );
      }
      return context.json(result);
    } catch (error) {
      if (error instanceof ConnectionError) {
        if (logContext) {
          const cancelled = error.code === "connection_cancelled";
          this.options.logger?.[cancelled ? "info" : "warn"](
            {
              ...logContext,
              errorCode: error.code,
            },
            cancelled
              ? "connection cancelled"
              : logContext.operation === "disconnect"
                ? "connection disconnect failed"
                : "connection failed",
          );
        }
        return jsonError(context, error.code === "unknown_service" ? 404 : 400, error.code, error.message);
      }

      throw error;
    }
  }

  private async writeOAuthResult(context: Context, operation: Promise<unknown>): Promise<Response> {
    try {
      return context.json(await operation);
    } catch (error) {
      if (error instanceof OAuthClientConfigError || error instanceof OAuthFlowError) {
        return jsonError(context, error.code === "unknown_service" ? 404 : 400, error.code, error.message);
      }
      if (error instanceof HttpRequestError) {
        return jsonError(context, 400, error.code, error.message);
      }

      throw error;
    }
  }

  private getPolicySnapshot(context: Context): Promise<ActionPolicySnapshot> {
    const request = context.req.raw;
    let snapshot = this.policySnapshots.get(request);
    if (!snapshot) {
      snapshot = this.loadPolicySnapshot(context);
      this.policySnapshots.set(request, snapshot);
    }
    return snapshot;
  }

  private async loadPolicySnapshot(context: Context): Promise<ActionPolicySnapshot> {
    try {
      const record = await this.options.runtimePolicyStore.get();
      return this.actionPolicy.createSnapshot(
        record?.rules ?? emptyPolicyRules(),
        readRuntimeGrant(context),
        record?.updatedAt,
      );
    } catch {
      this.options.logger?.error(
        {
          method: context.req.method,
          path: context.req.path,
        },
        "runtime policy load failed",
      );
      throw new Error("Runtime policy is unavailable.");
    }
  }
}

function readOAuthClientConfigInput(body: Record<string, unknown>): OAuthClientConfigInput | undefined {
  const keys = ["clientId", "clientSecret", "requestedScopes", "redirectUri", "extra", "secretExtra"];
  if (!keys.some((key) => key in body)) {
    return undefined;
  }

  return {
    clientId: optionalString(body.clientId) ?? "",
    clientSecret: optionalString(body.clientSecret) ?? "",
    requestedScopes: readOptionalStringArray(body, "requestedScopes"),
    redirectUri: readOptionalRawString(body, "redirectUri"),
    extra: optionalRecord(body.extra),
    secretExtra: optionalRecord(body.secretExtra),
  };
}

/** An absent field is undefined; a present one, null included, must be a string (blank is kept for the caller to read as unset). */
function readOptionalRawString(body: Record<string, unknown>, fieldName: string): string | undefined {
  if (!(fieldName in body)) return undefined;
  return requiredRawString(
    body[fieldName],
    fieldName,
    (message) => new HttpRequestError("invalid_input", `${message}.`),
  );
}

function readOptionalStringArray(body: Record<string, unknown>, fieldName: string): string[] | undefined {
  if (!(fieldName in body)) return undefined;
  return requiredStringArray(
    body[fieldName],
    fieldName,
    (message) => new HttpRequestError("invalid_input", `${message}.`),
  );
}

interface ConnectionLogContext extends Record<string, unknown> {
  operation: "connect" | "disconnect";
  path: string;
  service: string;
  authType?: string;
  connectionName?: string;
}

/**
 * RFC 7232 `If-None-Match` check. Handles `*`, comma-separated lists, and the
 * weak-comparison prefix (`W/`) so a validator round-tripped through gzip (which
 * downgrades strong to weak) still matches.
 */
function requestMatchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) {
    return false;
  }
  if (ifNoneMatch.trim() === "*") {
    return true;
  }
  const target = stripWeakPrefix(etag);
  return ifNoneMatch.split(",").some((candidate) => stripWeakPrefix(candidate.trim()) === target);
}

function stripWeakPrefix(etag: string): string {
  return etag.startsWith("W/") ? etag.slice(2) : etag;
}

function readConnectionName(context: Context, body?: Record<string, unknown>): string | undefined {
  return (
    optionalString(body?.connectionName) ??
    optionalString(body?.alias) ??
    optionalString(context.req.header("x-oo-connector-alias")) ??
    optionalString(context.req.query("connectionName")) ??
    optionalString(context.req.query("alias"))
  );
}

type SearchQuery =
  | {
      ok: true;
      q: string;
      service?: string;
      limit: number;
    }
  | {
      ok: false;
      message: string;
    };

type RunLogListQuery =
  | {
      ok: true;
      input: RunLogListInput;
    }
  | {
      ok: false;
      message: string;
    };

interface RuntimeActionSearchResult {
  id: string;
  service: string;
  name: string;
  description: string;
  operationType: RuntimeActionDefinition["operationType"];
  authenticated: boolean;
  inputSchema: RuntimeActionDefinition["inputSchema"];
  outputSchema: RuntimeActionDefinition["outputSchema"];
}

function serializeActionSearchResult(
  result: ActionSearchDocument,
  action: RuntimeActionDefinition,
  authenticated: boolean,
): RuntimeActionSearchResult {
  return {
    id: result.id,
    service: result.service,
    name: result.name,
    description: result.description,
    operationType: action.operationType,
    authenticated,
    inputSchema: action.inputSchema,
    outputSchema: action.outputSchema,
  };
}

function readRunLogListInput(context: Context): RunLogListQuery {
  const rawLimit = optionalString(context.req.query("limit"));
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { ok: false, message: "limit must be an integer between 1 and 100." };
  }

  const cursor = optionalString(context.req.query("cursor"));
  if (cursor !== undefined) {
    try {
      decodeRunLogCursor(cursor);
    } catch {
      return { ok: false, message: "cursor is invalid." };
    }
  }

  const input: RunLogListInput = { limit };
  if (cursor !== undefined) {
    input.cursor = cursor;
  }
  const service = optionalString(context.req.query("service"));
  if (service !== undefined) {
    input.service = service;
  }
  const actionId = optionalString(context.req.query("actionId"));
  if (actionId !== undefined) {
    if (actionId.length > 256) {
      return { ok: false, message: "actionId must be at most 256 characters." };
    }
    input.actionId = actionId;
  }
  const caller = optionalString(context.req.query("caller"));
  if (caller !== undefined) {
    if (!isRunLogCaller(caller)) {
      return { ok: false, message: "caller must be one of http, mcp, or web." };
    }
    input.caller = caller;
  }
  const ok = optionalString(context.req.query("ok"));
  if (ok !== undefined) {
    if (ok !== "true" && ok !== "false") {
      return { ok: false, message: "ok must be true or false." };
    }
    input.ok = ok === "true";
  }

  return { ok: true, input };
}

function isRunLogCaller(value: string): value is RunLogCaller {
  return value === "http" || value === "mcp" || value === "web";
}

function readSearchQuery(context: Context, defaultLimit = DEFAULT_ACTION_SEARCH_LIMIT): SearchQuery {
  const q = optionalString(context.req.query("q") ?? context.req.query("query"));
  if (!q || q.length > 256) {
    return { ok: false, message: "q must be a non-empty string of at most 256 characters." };
  }

  const rawLimit = optionalString(context.req.query("limit"));
  if (!rawLimit) {
    return {
      ok: true,
      q,
      service: optionalString(context.req.query("service")),
      limit: defaultLimit,
    };
  }

  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return { ok: false, message: "limit must be an integer between 1 and 50." };
  }

  return {
    ok: true,
    q,
    service: optionalString(context.req.query("service")),
    limit,
  };
}

/**
 * Pending-dedupe fingerprint for an approval request. Uses the idempotency
 * request hash when the input fits the depth limit; deep inputs fall back to a
 * raw serialized fingerprint so dedupe still works for oversized previews.
 */
function hashApprovalRequestFingerprint(request: ApprovalGateRequest, runtimeTokenId: string | undefined): string {
  try {
    return hashActionRequest({
      actionId: request.actionId,
      connectionName: request.request.connectionName ?? defaultConnectionName,
      connectionId: request.request.connectionId,
      input: request.request.input,
      runtimeTokenId,
    });
  } catch (error) {
    if (!(error instanceof ActionInputDepthError)) {
      throw error;
    }
    return hashIdempotencyKey(
      JSON.stringify({
        actionId: request.actionId,
        connectionName: request.request.connectionName,
        connectionId: request.request.connectionId,
        input: request.request.input,
        runtimeTokenId,
      }),
    );
  }
}

/** Maps a stored/fresh execution envelope onto an MCP tool payload. */
function approvalResultToolPayload(result: RuntimeActionHttpResult): Record<string, unknown> {
  const body = result.body;
  if (body.success) {
    return { ok: true, data: { status: "executed", result: body.data, meta: body.meta } };
  }
  return {
    ok: false,
    error: { code: body.errorCode ?? "execution_failed", message: body.message },
    data: { status: "failed", result: body.data, meta: body.meta },
  };
}

/** Validates the optional `{grant}` object on POST /api/approvals/:id/approve. */
function readCreateGrantInput(value: unknown): CreateGrantInput | string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = optionalRecord(value);
  if (!record) {
    return "grant must be an object.";
  }
  const ttlMinutes = optionalInteger(record.ttlMinutes);
  if (record.ttlMinutes !== undefined && ttlMinutes === undefined) {
    return "grant.ttlMinutes must be an integer.";
  }
  const maxUses = optionalInteger(record.maxUses);
  if (record.maxUses !== undefined && maxUses === undefined) {
    return "grant.maxUses must be an integer.";
  }
  const allowDestructive = optionalBoolean(record.allowDestructive);
  if (record.allowDestructive !== undefined && allowDestructive === undefined) {
    return "grant.allowDestructive must be a boolean.";
  }
  return { ttlMinutes, maxUses, allowDestructive };
}

/** Admin-facing approval serialization: no owner key, no ciphertext. */
function serializeAdminApproval(record: ApprovalRecord): Record<string, unknown> {
  return {
    id: record.id,
    kind: record.kind,
    actionId: record.actionId,
    service: record.service,
    connectionId: record.connectionId,
    connectionName: record.connectionName,
    connectionRequestId: record.connectionRequestId,
    operationType: record.operationType,
    caller: record.caller,
    runtimeTokenId: record.runtimeTokenId,
    preview: record.preview,
    status: record.status,
    decidedBy: record.decidedBy,
    decidedAt: record.decidedAt,
    decisionFactor: record.decisionFactor,
    decisionReason: record.decisionReason,
    grantId: record.grantId,
    executionId: record.executionId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
  };
}

function serializeApprovalGrant(grant: ApprovalGrantRecord): Record<string, unknown> {
  return {
    id: grant.id,
    approvalId: grant.approvalId,
    runtimeTokenId: grant.runtimeTokenId,
    actionId: grant.actionId,
    connectionId: grant.connectionId,
    operationType: grant.operationType,
    expiresAt: grant.expiresAt,
    maxUses: grant.maxUses,
    uses: grant.uses,
    createdBy: grant.createdBy,
    createdAt: grant.createdAt,
  };
}
