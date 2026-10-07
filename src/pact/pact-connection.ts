/**
 * The credential stored for a PACT Brand connection (spec §4.4). Written
 * verbatim into `connections.value` for `source = 'pact'` rows; PR5 fills
 * `delegation` after the device-flow grant, PR4 stores it absent.
 */
export interface PactConnectionCredential {
  authType: "oauth2";
  source: "pact";
  /** Card URL or origin the operator connected through. */
  cardUrl: string;
  /** Hostname portion of `cardUrl`, for console display. */
  brandDomain?: string;
  /** `supportedInterfaces` entry selected at validation time. */
  interfaceUrl: string;
  /** Origin of `provider.url` (or the interface URL when absent). */
  providerOrigin: string;
  /** Enabled PACT registration the connection was authorized under. */
  registrationId: string;
  card: PactCardSnapshot;
  delegation?: PactConnectionDelegation;
  profile: PactConnectionProfile;
}

/** Card facts kept on the credential so summaries do not refetch. */
export interface PactCardSnapshot {
  name: string;
  version?: string;
  skills: PactCardSkillSnapshot[];
  fetchedAt: string;
}

export interface PactCardSkillSnapshot {
  id: string;
  name: string;
  description: string;
  tags?: string[];
}

/** Delegation grant state; absent until PR5 completes the device flow. */
export interface PactConnectionDelegation {
  deviceAuthorizationUrl: string;
  tokenUrl: string;
  oauth2MetadataUrl?: string;
  scopes: Record<string, string>;
  accessToken?: string;
  refreshToken?: string;
  grantId?: string;
  grantedScopes?: string[];
  expiresAt?: string;
  tokenIssuer?: string;
  jwksUri?: string;
}

export interface PactConnectionProfile {
  accountId: string;
  displayName: string;
  grantedScopes?: string[];
}
