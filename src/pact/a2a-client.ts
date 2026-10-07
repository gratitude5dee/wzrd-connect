import { looseArray, optionalRecord, optionalString } from "../core/cast.ts";
import { readBoundedResponseBytes } from "../core/request.ts";
import { createProviderTimeout, isAbortLikeError, readRetryAfterSeconds } from "../providers/provider-runtime.ts";
import { PactEgressError, pactEgressFetch } from "./pact-fetch.ts";

/** PACT wire constants (PACT 1.0 / A2A protocol). */
export const pactA2AVersion: string = "1.0";
export const pactDelegationHeader: string = "X-A2A-User-Delegation";
export const pactReplyMaxBytes: number = 1024 * 1024;
const messageSendTimeoutMs: number = 30_000;

export interface PactA2AMessage {
  messageId?: string;
  contextId?: string;
  role?: string;
  parts: { text?: string; mediaType?: string }[];
  /** Free-form A2A metadata; `pact.receipt` rides here (PACT §5.6). */
  metadata?: Record<string, unknown>;
}

/** A2A Task object (PACT protocol TaskSchema): `status.state` carries the state enum. */
export interface PactA2ATask {
  id?: string;
  contextId?: string;
  state?: string;
  metadata: Record<string, unknown>;
}

export type PactSendReply = { kind: "message"; message: PactA2AMessage } | { kind: "task"; task: PactA2ATask };

/**
 * A PACT `message:send` failure: `reason` carries the A2A error envelope's
 * `error.details[0].reason` when the reply was an envelope; `httpStatus` is
 * always the wire status. The message never echoes headers or tokens.
 */
export class PactA2AError extends Error {
  readonly httpStatus: number;
  readonly reason?: string;
  readonly retryAfterSeconds?: number;

  constructor(httpStatus: number, message: string, options: { reason?: string; retryAfterSeconds?: number } = {}) {
    super(message);
    this.name = "PactA2AError";
    this.httpStatus = httpStatus;
    this.reason = options.reason;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export interface SendPactMessageOptions {
  /** Card-declared A2A interface URL; `message:send` is POSTed beneath it. */
  interfaceUrl: string;
  /** Fresh PA-JWT — `Authorization: Bearer`. */
  paJwt: string;
  /** Delegation token — sent only when present, scoped to this interface. */
  delegationToken?: string;
  /** `message.messageId`; the caller passes the execution id. */
  messageId: string;
  /** Opaque provider-minted conversation state, ≤256 bytes. */
  contextId?: string;
  text: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  allowInsecureLoopback?: boolean;
}

/**
 * POST `{interfaceUrl}/message:send` with the PACT wire contract: the three
 * headers (Authorization Bearer PA-JWT, A2A-Version 1.0, Content-Type json)
 * plus X-A2A-User-Delegation when a delegation token exists, and the
 * ROLE_USER text message body. Manual-redirect mode — a Brand redirect is a
 * provider failure, never followed with credentials attached.
 */
export async function sendPactMessage(options: SendPactMessageOptions): Promise<PactSendReply> {
  const url = `${options.interfaceUrl.replace(/\/+$/, "")}/message:send`;
  const timeout = createProviderTimeout(options.signal, messageSendTimeoutMs);
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.paJwt}`,
    "a2a-version": pactA2AVersion,
    "content-type": "application/json",
    accept: "application/json, application/a2a+json",
  };
  if (options.delegationToken) {
    headers[pactDelegationHeader.toLowerCase()] = `Bearer ${options.delegationToken}`;
  }
  try {
    const response = await pactEgressFetch(
      url,
      {
        method: "POST",
        headers,
        signal: timeout.signal,
        body: JSON.stringify({
          message: {
            messageId: options.messageId,
            contextId: options.contextId,
            role: "ROLE_USER",
            parts: [{ text: options.text, mediaType: "text/plain" }],
          },
        }),
      },
      { fetcher: options.fetcher, allowInsecureLoopback: options.allowInsecureLoopback },
    );
    return await readSendReply(response);
  } catch (error) {
    if (error instanceof PactA2AError || error instanceof PactEgressError) {
      throw error;
    }
    if (isAbortLikeError(error) || timeout.didTimeout()) {
      throw new PactA2AError(504, "PACT message request timed out");
    }
    throw new PactA2AError(0, "PACT message request failed");
  } finally {
    timeout.cleanup();
  }
}

async function readSendReply(response: Response): Promise<PactSendReply> {
  if (response.status === 429 || response.status === 503) {
    throw new PactA2AError(response.status, `PACT Brand answered ${response.status}`, {
      retryAfterSeconds: readRetryAfterSeconds(response.headers),
    });
  }
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: pactReplyMaxBytes,
    fieldName: "PACT reply",
    createError: (message) => new PactA2AError(response.status, message),
  });
  const text = new TextDecoder().decode(bytes).trim();
  if (!response.ok) {
    if (!text) {
      throw new PactA2AError(response.status, `PACT Brand answered ${response.status}`);
    }
    const body = parseReplyJson(text, response.status);
    const error = optionalRecord(body.error);
    if (!error) {
      throw new PactA2AError(response.status, `PACT Brand answered ${response.status}`);
    }
    const reason = readErrorReason(error);
    const message = optionalString(error.message) ?? `PACT Brand answered ${response.status}`;
    throw new PactA2AError(response.status, message, { reason });
  }
  const body = parseReplyJson(text, response.status);
  const message = optionalRecord(body.message);
  if (message) {
    return {
      kind: "message",
      message: {
        messageId: optionalString(message.messageId),
        contextId: optionalString(message.contextId),
        role: optionalString(message.role),
        parts: looseArray(message.parts).map((part) => {
          const record = optionalRecord(part) ?? {};
          return { text: optionalString(record.text), mediaType: optionalString(record.mediaType) };
        }),
        metadata: optionalRecord(message.metadata),
      },
    };
  }
  const task = optionalRecord(body.task);
  if (task) {
    const status = optionalRecord(task.status);
    return {
      kind: "task",
      task: {
        id: optionalString(task.id),
        contextId: optionalString(task.contextId),
        state: optionalString(status?.state),
        metadata: optionalRecord(task.metadata) ?? {},
      },
    };
  }
  throw new PactA2AError(response.status, "PACT reply carried no message or task");
}

function parseReplyJson(text: string, status: number): Record<string, unknown> {
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // fall through to the failure below
  }
  throw new PactA2AError(status, "PACT reply is not valid JSON");
}

function readErrorReason(error: Record<string, unknown>): string | undefined {
  for (const entry of looseArray(error.details)) {
    const detail = optionalRecord(entry);
    const reason = optionalString(detail?.reason);
    if (reason) {
      return reason;
    }
  }
  return undefined;
}
