import type { CatalogStore } from "../catalog-store.ts";
import type { ActionPolicyService } from "../core/action-policy.ts";
import type { ProviderHttpDispatchOptions } from "../core/provider-http-dispatch.ts";
import type { RuntimeLogger, TransitFileUpload } from "../core/types.ts";
import type { IProviderLoader } from "../providers/provider-loader.ts";
import type { RuntimeJwtVerifier } from "./api/runtime-jwt.ts";
import type { ITransitFileService } from "./files/transit-file-store.ts";
import type { ISecretCodec } from "./secrets/secret-codec-core.ts";
import type { RuntimeDatabase } from "./storage/runtime-database.ts";
import type { Hono } from "hono";

import { ConnectionService } from "../connection-service.ts";
import { ActionPolicyService as ExecutionPolicyService } from "../core/action-policy.ts";
import { MarketplaceService } from "../marketplace/marketplace-service.ts";
import { OAuthClientConfigService } from "../oauth/oauth-client-config-service.ts";
import { OAuthCredentialRefreshService } from "../oauth/oauth-credential-refresh-service.ts";
import { OAuthFlowService } from "../oauth/oauth-flow-service.ts";
import { PactDelegationService } from "../pact/pact-delegation-service.ts";
import { PactIdentityService } from "../pact/pact-identity-service.ts";
import { PactReceiptService } from "../pact/pact-receipts.ts";
import { PactService } from "../pact/pact-service.ts";
import { SaasCleanupService } from "../saas/saas-cleanup-service.ts";
import { SaasClient } from "../saas/saas-client.ts";
import { SaasExecutionService } from "../saas/saas-execution-service.ts";
import { SaasOAuthService } from "../saas/saas-oauth-service.ts";
import { SaasProjectService } from "../saas/saas-project-service.ts";
import { TriggerMaintenance } from "../triggers/maintenance.ts";
import { TriggerRunner } from "../triggers/trigger-runner.ts";
import { ActionRunner } from "./actions/action-runner.ts";
import { ApprovalMaintenance } from "./approvals/approval-maintenance.ts";
import { ApprovalService } from "./approvals/approval-service.ts";
import { ConnectServer } from "./connect-server.ts";
import { RuntimeTokenService } from "./storage/runtime-token-service.ts";

export interface ConnectAppOptions {
  catalog: CatalogStore;
  providerLoader: IProviderLoader;
  providerHttpDispatch?: ProviderHttpDispatchOptions;
  runtimeDatabase: RuntimeDatabase;
  transitFiles: ITransitFileService;
  uploadTransitFile?: (request: Request) => Promise<TransitFileUpload>;
  publicOrigin: string;
  configuredOrigin?: string;
  secretCodec: ISecretCodec;
  adminToken?: string;
  runtimeToken?: string;
  allowedCustomOAuth?: string[];
  verifyRuntimeJwt?: RuntimeJwtVerifier;
  actionPolicy?: ActionPolicyService;
  /** Pending-approval TTL override; falls back to the service default. */
  approvalTtlSeconds?: number;
  /** PACT identity/registration wiring; `enabled` mounts every PACT route. */
  pact?: ConnectPactOptions;
  registerStaticRoutes?: (app: Hono) => void;
  logger?: RuntimeLogger;
  computeRuntimeAuthConfigured?: boolean;
  compressApiResponses?: boolean;
  serveDocumentation?: boolean;
  /** Streams `/api/actions` from a prebuilt catalog asset when the host serves one (see `IConnectServerOptions`). */
  fetchActionsAsset?: (request: Request) => Promise<Response>;
  /** Streams `/api/providers` from a prebuilt summaries asset when the host serves one (see `IConnectServerOptions`). */
  fetchProvidersAsset?: (request: Request) => Promise<Response>;
}

export interface ConnectPactOptions {
  /** `OOMOL_CONNECT_PACT_ENABLED` — every PACT route and service stays off when false. */
  enabled: boolean;
  /** `OOMOL_CONNECT_PACT_KEY_GRACE_SECONDS` — JWKS grace for the outgoing key after rotation. */
  keyGraceSeconds?: number;
  /** `OOMOL_CONNECT_PACT_ALLOW_INSECURE_LOOPBACK` — permits http://loopback PACT Brand targets (dev only). */
  allowInsecureLoopback?: boolean;
  /** `OOMOL_CONNECT_PACT_STRICT_RECEIPTS` — 502 pact_receipt_invalid on unverified Brand receipts. */
  strictReceipts?: boolean;
}

export interface ConnectApp {
  saasCleanup: SaasCleanupService;
  triggerMaintenance: TriggerMaintenance;
  approvalMaintenance: ApprovalMaintenance;
  app: Hono;
  runtimeAuthConfigured: boolean;
}

export async function createConnectApp(options: ConnectAppOptions): Promise<ConnectApp> {
  const saasClient = new SaasClient();
  const saasProject = new SaasProjectService({
    catalog: options.catalog,
    store: options.runtimeDatabase.saasProjectStore,
    secretCodec: options.secretCodec,
    configuredOrigin: options.configuredOrigin,
    client: saasClient,
  });
  const saasOAuth = new SaasOAuthService({
    projects: saasProject,
    requests: options.runtimeDatabase.connectionRequestStore,
    client: saasClient,
  });
  const saas = new SaasExecutionService({ projects: saasProject, client: saasClient });
  const marketplace = new MarketplaceService({
    catalog: options.catalog,
    store: options.runtimeDatabase.marketplaceStore,
    secretCodec: options.secretCodec,
  });
  await marketplace.initialize();
  const runtimeTokens = new RuntimeTokenService(options.runtimeDatabase.runtimeTokenStore, options.logger);
  const hasStoredRuntimeTokens = async (): Promise<boolean> => (await runtimeTokens.listTokens()).length > 0;
  const allowedCustomOAuth = new Set(options.allowedCustomOAuth);
  const isCustomClientConfigAllowed = (service: string): boolean =>
    allowedCustomOAuth.has("*") || allowedCustomOAuth.has(service);
  const oauthClientConfigs = new OAuthClientConfigService({
    catalog: options.catalog,
    origin: options.publicOrigin,
    store: options.runtimeDatabase.oauthClientConfigStore,
    isCustomClientConfigAvailable: (service) => options.secretCodec.encrypted && isCustomClientConfigAllowed(service),
  });
  const pact = options.pact?.enabled
    ? (() => {
        const identity = new PactIdentityService({
          store: options.runtimeDatabase.pactIdentityStore,
          secretCodec: options.secretCodec,
          issuer: options.configuredOrigin,
          keyGraceSeconds: options.pact!.keyGraceSeconds,
        });
        const delegation = new PactDelegationService({
          requests: options.runtimeDatabase.connectionRequestStore,
          store: options.runtimeDatabase.connectionStore,
          registrations: options.runtimeDatabase.pactRegistrationStore,
          identity,
          allowInsecureLoopback: options.pact!.allowInsecureLoopback,
          logger: options.logger,
        });
        const receipts = new PactReceiptService({
          identity,
          allowInsecureLoopback: options.pact!.allowInsecureLoopback,
        });
        return {
          identity,
          registrations: options.runtimeDatabase.pactRegistrationStore,
          delegation,
          receipts,
          service: new PactService({
            store: options.runtimeDatabase.connectionStore,
            registrations: options.runtimeDatabase.pactRegistrationStore,
            identity,
            delegation,
            receipts,
            strictReceipts: options.pact!.strictReceipts,
            allowInsecureLoopback: options.pact!.allowInsecureLoopback,
            logger: options.logger,
          }),
        };
      })()
    : undefined;
  const connections = new ConnectionService({
    providerHttpDispatch: options.providerHttpDispatch,
    catalog: options.catalog,
    oauthCredentials: new OAuthCredentialRefreshService(oauthClientConfigs, options.providerLoader),
    providerLoader: options.providerLoader,
    store: options.runtimeDatabase.connectionStore,
    logger: options.logger,
    marketplace,
    pactRevocation: pact ? (stored) => pact.delegation.revokeGrant(stored) : undefined,
  });
  const approvals = new ApprovalService({
    store: options.runtimeDatabase.approvalStore,
    ttlSeconds: options.approvalTtlSeconds,
    logger: options.logger,
  });
  const actions = new ActionRunner({
    providerHttpDispatch: options.providerHttpDispatch,
    catalog: options.catalog,
    providerLoader: options.providerLoader,
    connections,
    runs: options.runtimeDatabase.runLogStore,
    saas,
    transitFiles: options.transitFiles,
    logger: options.logger,
    marketplace,
    pact: pact?.service,
    receipts: pact?.receipts,
    approvals,
  });

  const triggers = new TriggerRunner({
    providerHttpDispatch: options.providerHttpDispatch,
    catalog: options.catalog,
    providerLoader: options.providerLoader,
    connections,
    store: options.runtimeDatabase.triggerStore,
  });
  const triggerMaintenance = new TriggerMaintenance({
    store: options.runtimeDatabase.triggerStore,
    runner: triggers,
    tokens: options.runtimeDatabase.runtimeTokenStore,
    runtimePolicy: options.runtimeDatabase.runtimePolicyStore,
    deploymentPolicy: options.actionPolicy ?? new ExecutionPolicyService(),
    logger: options.logger,
  });
  return {
    triggerMaintenance,
    approvalMaintenance: new ApprovalMaintenance({ service: approvals, logger: options.logger }),
    saasCleanup: new SaasCleanupService({
      store: options.runtimeDatabase.saasProjectStore,
      requests: options.runtimeDatabase.connectionRequestStore,
      client: saasClient,
      logger: options.logger,
    }),
    app: new ConnectServer({
      providerHttpDispatch: options.providerHttpDispatch,
      catalog: options.catalog,
      publicOrigin: options.publicOrigin,
      providerLoader: options.providerLoader,
      connections,
      oauthClientConfigs,
      oauthFlow: new OAuthFlowService({
        clientConfigs: oauthClientConfigs,
        connections,
        providerLoader: options.providerLoader,
        states: options.runtimeDatabase.oauthStateStore,
        requests: options.runtimeDatabase.connectionRequestStore,
        secretCodec: options.secretCodec,
        isCustomClientConfigAllowed,
        saasOAuth,
      }),
      actions,
      triggers,
      triggerMaintenance,
      approvals,
      pact,
      idempotency: options.runtimeDatabase.idempotencyStore,
      transitFiles: options.transitFiles,
      uploadTransitFile: options.uploadTransitFile,
      runtimeTokens,
      runtimePolicyStore: options.runtimeDatabase.runtimePolicyStore,
      registerStaticRoutes: options.registerStaticRoutes,
      auth: {
        adminToken: options.adminToken,
        runtimeToken: options.runtimeToken,
        hasRuntimeTokens: hasStoredRuntimeTokens,
        resolveRuntimeToken: (token) => runtimeTokens.resolveToken(token),
        verifyRuntimeJwt: options.verifyRuntimeJwt,
      },
      actionPolicy: options.actionPolicy,
      logger: options.logger,
      marketplace,
      saas,
      saasProject,
      saasOAuth,
      compressApiResponses: options.compressApiResponses,
      serveDocumentation: options.serveDocumentation,
      fetchActionsAsset: options.fetchActionsAsset,
      fetchProvidersAsset: options.fetchProvidersAsset,
    }).createApp(),
    runtimeAuthConfigured:
      Boolean(options.runtimeToken) ||
      Boolean(options.verifyRuntimeJwt) ||
      (options.computeRuntimeAuthConfigured === false ? false : await hasStoredRuntimeTokens()),
  };
}
