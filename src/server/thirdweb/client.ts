import { optionalBoolean, optionalRecord, optionalString } from "../../core/cast.ts";
import { readRemoteJson, RemoteHttpError, requestRemote } from "../../core/remote-http.ts";

const thirdwebApiBaseUrl = "https://api.thirdweb.com";
const thirdwebRequestTimeoutMs = 10_000;
const thirdwebResponseMaxBytes = 64 * 1024;

/** Upstream failure talking to api.thirdweb.com; `status` is 0 for transport-level failures. */
export class ThirdwebApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ThirdwebApiError";
    this.status = status;
  }
}

export type ThirdwebAuthChannel = "sms" | "email";

export interface ThirdwebInitiateInput {
  channel: ThirdwebAuthChannel;
  phone?: string;
  email?: string;
}

export interface ThirdwebCompleteInput extends ThirdwebInitiateInput {
  code: string;
}

/** The thirdweb auth/complete result: the user's wallet plus their server-side session token. */
export interface ThirdwebAuthResult {
  walletAddress: string;
  isNewUser: boolean;
  token: string;
}

export interface ThirdwebClientOptions {
  secretKey: string;
  fetcher?: typeof fetch;
}

/** Minimal surface the auth routes need; `ThirdwebClient` implements it and tests inject fakes. */
export interface ThirdwebAuthClient {
  initiateAuth(input: ThirdwebInitiateInput): Promise<void>;
  completeAuth(input: ThirdwebCompleteInput): Promise<ThirdwebAuthResult>;
}

function authIdentityBody(input: ThirdwebInitiateInput): Record<string, string> {
  return {
    method: input.channel,
    phone: input.phone ?? "",
    email: input.email ?? "",
  };
}

/** thirdweb server-side auth API (SMS/email OTP), authenticated with the project secret key. */
export class ThirdwebClient implements ThirdwebAuthClient {
  private readonly secretKey: string;
  private readonly fetcher?: typeof fetch;

  constructor(options: ThirdwebClientOptions) {
    this.secretKey = options.secretKey;
    this.fetcher = options.fetcher;
  }

  async initiateAuth(input: ThirdwebInitiateInput): Promise<void> {
    // thirdweb's initiate body shape is not contractual; only the status matters.
    await this.post("/v1/auth/initiate", authIdentityBody(input), false);
  }

  async completeAuth(input: ThirdwebCompleteInput): Promise<ThirdwebAuthResult> {
    const data = await this.post("/v1/auth/complete", { ...authIdentityBody(input), code: input.code }, true);
    // The response is usually wrapped in { result: {...} }; accept the flat shape as a fallback.
    const envelope = optionalRecord(data);
    const result = optionalRecord(envelope?.result) ?? envelope;
    const walletAddress = optionalString(result?.walletAddress);
    const token = optionalString(result?.token);
    if (!walletAddress || !token) {
      throw new ThirdwebApiError(0, "thirdweb auth complete response is missing the wallet or token.");
    }
    return { walletAddress, isNewUser: optionalBoolean(result?.isNewUser) ?? false, token };
  }

  private async post(path: string, body: Record<string, string>, expectJson: boolean): Promise<unknown> {
    try {
      return await requestRemote(
        {
          url: `${thirdwebApiBaseUrl}${path}`,
          label: "thirdweb",
          timeoutMs: thirdwebRequestTimeoutMs,
          fetcher: this.fetcher,
          init: {
            method: "POST",
            headers: { "content-type": "application/json", "x-secret-key": this.secretKey },
            body: JSON.stringify(body),
          },
        },
        async (response, signal) => {
          if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new ThirdwebApiError(
              response.status,
              `thirdweb ${path} failed (${response.status}): ${text.slice(0, 500)}`,
            );
          }
          if (!expectJson) {
            return undefined;
          }
          return await readRemoteJson(response, {
            label: "thirdweb response",
            maxBytes: thirdwebResponseMaxBytes,
            signal,
          });
        },
      );
    } catch (error) {
      if (error instanceof ThirdwebApiError) {
        throw error;
      }
      if (error instanceof RemoteHttpError) {
        throw new ThirdwebApiError(0, error.message);
      }
      throw new ThirdwebApiError(0, "thirdweb request failed.");
    }
  }
}
