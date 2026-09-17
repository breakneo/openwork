import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import { desktopFetch, desktopFetchViaMain, isPermissionReplyRequest } from "./desktop";
import { isDesktopRuntime } from "./runtime-env";

export type FieldsResult<T> =
  | ({ data: T; error?: undefined } & { request: Request; response: Response })
  | ({ data?: undefined; error: unknown } & { request: Request; response: Response });

type PromptAsyncParameters = {
  sessionID: string;
  directory?: string;
  messageID?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  noReply?: boolean;
  tools?: { [key: string]: boolean };
  system?: string;
  variant?: string;
  parts?: unknown[];
  reasoning_effort?: string;
};

type CommandParameters = {
  sessionID: string;
  directory?: string;
  messageID?: string;
  agent?: string;
  model?: string;
  arguments?: string;
  command?: string;
  variant?: string;
  parts?: unknown[];
  reasoning_effort?: string;
};

export type OpencodeAuth = {
  username?: string;
  password?: string;
  token?: string;
  mode?: "basic" | "openwork";
};

const DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS = 10_000;
const OAUTH_OPENCODE_REQUEST_TIMEOUT_MS = 5 * 60_000;
const MCP_AUTH_OPENCODE_REQUEST_TIMEOUT_MS = 90_000;
// Bound the acceptance handshake, not the task. A timeout leaves admission
// unknown, so the transport must never automatically resend the prompt.
const PROMPT_ASYNC_REQUEST_TIMEOUT_MS = 30_000;
const SESSION_LONG_RUNNING_URL_RE = /\/session\/[^/?#]+\/(?:command|summarize)(?:[?#]|$)/;
const SESSION_PROMPT_ASYNC_URL_RE = /\/session\/[^/?#]+\/prompt_async(?:[?#]|$)/;

export class PromptAdmissionUnknownError extends Error {
  readonly admission = "unknown";

  constructor(options?: { cause?: unknown; messageID?: string }) {
    super("Message acceptance is unknown. It may already be running; do not resend it while checking the conversation.", { cause: options?.cause });
    this.name = "PromptAdmissionUnknownError";
    this.messageID = options?.messageID;
  }

  readonly messageID?: string;
}

export function isPromptAdmissionUnknown(error: unknown): error is PromptAdmissionUnknownError {
  return error instanceof PromptAdmissionUnknownError;
}

export type ServerPromptAdmission = "queued" | "forwarding" | "accepted" | "cancelled" | "rejected" | "unknown";
type AdmissionReply = { state: ServerPromptAdmission; ticket?: string };
const admissionReaders = new WeakMap<object, (sessionID: string, messageID: string, cancel: boolean) => Promise<ServerPromptAdmission>>();
// Survive SDK client recreation/reconnects. Do not evict admission identities
// and accidentally prepare a new ticket for an uncertain prior submission.
// Keep only digests, never raw credentials. There is no lifetime send quota:
// these small replay guards live until this application runtime is released.
const preparedPromptMessages = new Set<string>();

async function promptPreparationKey(baseUrl: string, token: string | undefined, sessionID: string, messageID: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([baseUrl, token, sessionID, messageID])));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseAdmissionReply(value: unknown): AdmissionReply | undefined {
  if (!value || typeof value !== "object" || !("protocol" in value) || value.protocol !== "openwork-prompt-admission-v1"
    || !("state" in value)) return undefined;
  const state = value.state;
  if (state !== "queued" && state !== "forwarding" && state !== "accepted" && state !== "cancelled"
    && state !== "rejected" && state !== "unknown") return undefined;
  return { state, ...("ticket" in value && typeof value.ticket === "string" ? { ticket: value.ticket } : {}) };
}

export async function cancelPromptAdmission(client: object, sessionID: string, messageID: string): Promise<ServerPromptAdmission> {
  return admissionReaders.get(client)?.(sessionID, messageID, true).catch((): ServerPromptAdmission => "unknown") ?? "unknown";
}

async function serverPromptAdmission(client: object, sessionID: string, messageID: string): Promise<ServerPromptAdmission> {
  return admissionReaders.get(client)?.(sessionID, messageID, false).catch((): ServerPromptAdmission => "unknown") ?? "unknown";
}

/** The settled server failure behind an uncertain admission: the parsed
 * response body when the server answered, otherwise the transport error or
 * undefined for a timeout. It explains the failure; it never proves rejection. */
export function promptAdmissionFailure(error: PromptAdmissionUnknownError): unknown {
  let cause: unknown = error.cause;
  while (isPromptAdmissionUnknown(cause)) cause = cause.cause;
  return cause;
}

async function readSettledFailure(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
}

let lastMessageStamp = 0;

/** Native sortable msg_ format. This identifies a submission, NOT an idempotency key. */
export function createPromptMessageID(): string {
  lastMessageStamp = Math.max(Date.now() * 0x1000, lastMessageStamp + 1);
  // Native stores the low six bytes of the timestamp/counter, then 14 random characters.
  return `msg_${lastMessageStamp.toString(16).padStart(12, "0").slice(-12)}${crypto.randomUUID().replaceAll("-", "").slice(0, 14)}`;
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return String(input);
}

function resolveRequestTimeoutMs(input: RequestInfo | URL, fallbackMs: number): number {
  const url = getRequestUrl(input);
  if (SESSION_LONG_RUNNING_URL_RE.test(url)) {
    return 0;
  }
  if (SESSION_PROMPT_ASYNC_URL_RE.test(url)) {
    return Math.max(fallbackMs, PROMPT_ASYNC_REQUEST_TIMEOUT_MS);
  }
  if (/\/provider\/oauth\//.test(url) || /\/mcp\/auth\/callback\b/.test(url)) {
    return Math.max(fallbackMs, OAUTH_OPENCODE_REQUEST_TIMEOUT_MS);
  }
  if (/\/mcp\/.*auth\b/.test(url)) {
    return Math.max(fallbackMs, MCP_AUTH_OPENCODE_REQUEST_TIMEOUT_MS);
  }
  return fallbackMs;
}


function buildDirectoryHeader(directory?: string) {
  if (!directory?.trim()) return undefined;
  const trimmed = directory.trim();
  return /[^\x00-\x7F]/.test(trimmed) ? encodeURIComponent(trimmed) : trimmed;
}

async function postSessionRequest<T>(
  fetchImpl: typeof globalThis.fetch,
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  options?: { headers?: Record<string, string>; directory?: string; throwOnError?: boolean; signal?: AbortSignal },
): Promise<FieldsResult<T>> {
  const headers = new Headers(options?.headers);
  headers.set("Content-Type", "application/json");
  const directoryHeader = buildDirectoryHeader(options?.directory);
  if (directoryHeader) {
    headers.set("x-opencode-directory", directoryHeader);
  }

  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: options?.signal,
  });

  const request = new Request(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (response.ok) {
    let data: T;
    try {
      data = response.status === 204 ? ({} as T) : ((await response.json()) as T);
    } catch (cause) {
      if (SESSION_PROMPT_ASYNC_URL_RE.test(path)) throw new PromptAdmissionUnknownError({ cause });
      throw cause;
    }
    return { data, request, response };
  }

  const text = await response.text();
  let error: unknown = text;
  try {
    error = text ? JSON.parse(text) : text;
  } catch {
    // ignore
  }
  if (options?.throwOnError) throw error;
  return { error, request, response };
}

function resolveOpenworkWorkspaceMount(baseUrl: string): { baseUrl: string; workspaceId: string } | null {
  try {
    const url = new URL(baseUrl);
    const match = url.pathname
      .replace(/\/+$/, "")
      .match(/^(.*)\/(?:w|workspace)\/([^/]+)\/opencode$/);
    if (!match || match[1] === undefined || !match[2]) return null;
    url.pathname = match[1] || "/";
    url.search = "";
    return {
      baseUrl: url.toString().replace(/\/+$/, ""),
      workspaceId: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
  cancelPermissionReply = false,
) {
  const effectiveTimeoutMs = cancelPermissionReply ? timeoutMs : resolveRequestTimeoutMs(input, timeoutMs);
  if (!Number.isFinite(effectiveTimeoutMs) || effectiveTimeoutMs <= 0) {
    return fetchImpl(input, init);
  }

  const cancellable = cancelPermissionReply || ["GET", "PATCH"].includes((init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase());
  const callerSignal = cancellable
    ? init?.signal === undefined ? (input instanceof Request ? input.signal : undefined) : init.signal
    : undefined;
  callerSignal?.throwIfAborted();
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = cancellable && callerSignal && controller
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller?.signal;
  const initWithSignal = signal && (cancellable || !init?.signal) ? { ...(init ?? {}), signal } : init;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        controller?.abort(cancellable ? new Error("Request timed out.") : undefined);
      } catch {
        // ignore
      }
      reject(new Error("Request timed out."));
    }, effectiveTimeoutMs);
  });

  try {
    const response = await Promise.race([fetchImpl(input, initWithSignal), timeoutPromise]);
    // A proxy/server failure can happen after native admission. Only an
    // explicit client rejection establishes that the prompt was not accepted.
    if (SESSION_PROMPT_ASYNC_URL_RE.test(getRequestUrl(input)) && (response.status >= 500 || response.status === 408)) {
      throw new PromptAdmissionUnknownError({ cause: await readSettledFailure(response) });
    }
    return response;
  } catch (error) {
    if (cancellable) {
      signal?.throwIfAborted();
      throw error;
    }
    if (SESSION_PROMPT_ASYNC_URL_RE.test(getRequestUrl(input))) {
      throw isPromptAdmissionUnknown(error) ? error : new PromptAdmissionUnknownError({ cause: error });
    }
    if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
      throw new Error("Request timed out.");
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

const encodeBasicAuth = (auth?: OpencodeAuth) => {
  if (!auth?.username || !auth?.password) return null;
  const token = `${auth.username}:${auth.password}`;
  if (typeof btoa === "function") return btoa(token);
  const buffer = (globalThis as { Buffer?: { from: (input: string, encoding: string) => { toString: (encoding: string) => string } } })
    .Buffer;
  return buffer ? buffer.from(token, "utf8").toString("base64") : null;
};

const resolveAuthHeader = (auth?: OpencodeAuth) => {
  if (auth?.mode === "openwork" && auth.token) {
    return `Bearer ${auth.token}`;
  }
  const encoded = encodeBasicAuth(auth);
  return encoded ? `Basic ${encoded}` : null;
};

/**
 * URLs whose response body we must stream chunk-by-chunk (SSE, long-running
 * message streams, event subscriptions). The Tauri HTTP plugin's
 * `fetch_read_body` IPC call blocks until the entire body is delivered, so
 * pointing it at an infinite stream freezes the webview's main thread for
 * minutes. For these endpoints we always use the webview's native fetch —
 * CORS is already wide open on the openwork/opencode stack, so there's no
 * reason to route them through the plugin.
 */
const STREAM_URL_RE = /\/(event|stream)(\b|\/|$|\?)/;

function requestIsStreaming(input: RequestInfo | URL, init?: RequestInit): boolean {
  const url = getRequestUrl(input);
  if (STREAM_URL_RE.test(url)) return true;
  const accept = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("accept");
  return typeof accept === "string" && accept.toLowerCase().includes("text/event-stream");
}

function nativeFetchRef(): typeof globalThis.fetch {
  if (typeof window !== "undefined" && typeof window.fetch === "function") return window.fetch.bind(window);
  return globalThis.fetch as typeof globalThis.fetch;
}

export const createDesktopFetch = (auth?: OpencodeAuth, finiteFetch: typeof globalThis.fetch = desktopFetch) => {
  const authHeader = resolveAuthHeader(auth);
  const addAuth = (headers: Headers) => {
    if (!authHeader || headers.has("Authorization")) return;
    headers.set("Authorization", authHeader);
  };

  return (input: RequestInfo | URL, init?: RequestInit) => {
    // Streams must go through the webview's native fetch to avoid the
    // Tauri HTTP plugin's `fetch_read_body` hang on never-closing bodies.
    const shouldStream = requestIsStreaming(input, init);
    const permissionReply = isPermissionReplyRequest(input, init);
    const underlyingFetch = shouldStream
      ? nativeFetchRef()
      : permissionReply && finiteFetch === desktopFetch ? desktopFetchViaMain : finiteFetch;
    // Streams should never be timed out at the transport layer; the caller
    // aborts via AbortSignal when the subscription unmounts.
    const timeoutMs = shouldStream ? 0 : DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS;

    if (permissionReply && !(input instanceof Request)) input = new Request(input, init);
    if (input instanceof Request) {
      const requestInit = permissionReply || isPermissionReplyRequest(input) || ["GET", "PATCH"].includes((init?.method ?? input.method).toUpperCase()) ? init : undefined;
      const headers = new Headers(requestInit?.headers ?? input.headers);
      addAuth(headers);
      const request = new Request(input, { ...requestInit, headers });
      // Keep an explicit null override even in runtimes whose Request clone
      // retains the original signal when constructed with signal: null.
      return fetchWithTimeout(underlyingFetch, request, { signal: requestInit?.signal }, timeoutMs, permissionReply);
    }

    const headers = new Headers(init?.headers);
    addAuth(headers);
    return fetchWithTimeout(
      underlyingFetch,
      input,
      {
        ...init,
        headers,
      },
      timeoutMs,
      permissionReply,
    );
  };
};

export function unwrap<T>(result: FieldsResult<T>): NonNullable<T> {
  if (result.data !== undefined) {
    return result.data as NonNullable<T>;
  }
  if (isPromptAdmissionUnknown(result.error)) throw result.error;
  const message =
    result.error instanceof Error
      ? result.error.message
      : typeof result.error === "string"
        ? result.error
        : JSON.stringify(result.error);
  throw new Error(message || "Unknown error");
}

export function createClient(baseUrl: string, directory?: string, auth?: OpencodeAuth, options?: { desktopTransport: "main" }) {
  const headers: Record<string, string> = {};
  if (!isDesktopRuntime()) {
    const authHeader = resolveAuthHeader(auth);
    if (authHeader) {
      headers.Authorization = authHeader;
    }
  }

  const fetchImpl = isDesktopRuntime()
    ? createDesktopFetch(auth, options?.desktopTransport === "main" ? desktopFetchViaMain : desktopFetch)
    : (input: RequestInfo | URL, init?: RequestInit) => {
        const timeoutMs = requestIsStreaming(input, init) ? 0 : DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS;
        return fetchWithTimeout(globalThis.fetch, input, init, timeoutMs);
      };
  const client = createOpencodeClient({
    baseUrl,
    directory,
    headers: Object.keys(headers).length ? headers : undefined,
    fetch: fetchImpl,
  });

  const session = client.session as typeof client.session;
  const openworkMount = auth?.mode === "openwork" ? resolveOpenworkWorkspaceMount(baseUrl) : null;
  if (openworkMount) {
    admissionReaders.set(client, (sessionID, messageID, cancel) => withAdmissionDeadline<ServerPromptAdmission>(DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS, async (signal) => {
      const response = await fetchImpl(`${baseUrl}/session/${encodeURIComponent(sessionID)}/prompt-admission/${encodeURIComponent(messageID)}`, {
        method: cancel ? "DELETE" : "GET", headers, signal, cache: "no-store",
      });
      if (!response.ok) return "unknown";
      return parseAdmissionReply(await response.json())?.state ?? "unknown";
    }, () => new Error("Admission check timed out.")));
  }
  const sessionOverrides = session as any as {
    promptAsync: (parameters: PromptAsyncParameters, options?: { throwOnError?: boolean }) => Promise<FieldsResult<{}>>;
    command: (parameters: CommandParameters, options?: { throwOnError?: boolean }) => Promise<FieldsResult<{}>>;
  };

  sessionOverrides.promptAsync = async (parameters: PromptAsyncParameters, options?: { throwOnError?: boolean }) => {
    const { sessionID, directory: requestDirectory, ...body } = parameters;
    let tracked = false;
    let canReconcile = false;
    let preparationRejected = false;
    try {
      // Keep the tagged transport failure intact instead of serializing it
      // through the SDK's error result. Native still receives prompt_async.
      return await withAdmissionDeadline(PROMPT_ASYNC_REQUEST_TIMEOUT_MS, async (signal) => {
        const promptHeaders: Record<string, string> = { ...headers };
        if (openworkMount && parameters.messageID) {
          // Preparing never dispatches, but repeating preparation after losing
          // a ticket could authorize a second submission on a restarted server.
          const key = await promptPreparationKey(baseUrl, auth?.token, sessionID, parameters.messageID);
          signal.throwIfAborted();
          if (preparedPromptMessages.has(key)) throw new PromptAdmissionUnknownError({ messageID: parameters.messageID });
          preparedPromptMessages.add(key);
          tracked = true;
          const prepared = await fetchImpl(`${baseUrl}/session/${encodeURIComponent(sessionID)}/prompt-admission`, {
            method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
          });
          if ([400, 401, 403].includes(prepared.status)) {
            // Preparation cannot dispatch. A definite validation/auth/policy
            // refusal is an ordinary error, not an ambiguous native send.
            preparedPromptMessages.delete(key);
            tracked = false;
            preparationRejected = true;
            const error = await readSettledFailure(prepared) ?? { message: "Message preparation was rejected." };
            if (options?.throwOnError) throw error;
            return { error, request: new Request(`${baseUrl}/session/${encodeURIComponent(sessionID)}/prompt-admission`, {
              method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
            }), response: prepared };
          }
          // Only an unsupported prepare route permits legacy forwarding. Never
          // fall back after a ticketed dispatch or any ambiguous prepare error.
          if (prepared.status !== 404) {
            const preparedValue: unknown = await prepared.json();
            const admission = parseAdmissionReply(preparedValue);
            canReconcile = prepared.ok && Boolean(admission?.ticket);
            if (!prepared.ok || !admission?.ticket || admission.state !== "queued") {
              throw new PromptAdmissionUnknownError({ cause: preparedValue, messageID: parameters.messageID });
            }
            promptHeaders["x-openwork-prompt-ticket"] = admission.ticket;
          } else tracked = false;
          // Some desktop transports ignore abort. A late prepare must never
          // continue into dispatch after the client's admission deadline.
          signal.throwIfAborted();
        }
        const result = await postSessionRequest<{}>(fetchImpl, baseUrl, `/session/${encodeURIComponent(sessionID)}/prompt_async`, body, {
          headers: promptHeaders,
          directory: requestDirectory ?? directory,
          throwOnError: options?.throwOnError,
          signal,
        });
        if (tracked && result.error !== undefined && parameters.messageID) {
          const state = await serverPromptAdmission(client, sessionID, parameters.messageID);
          if (state !== "cancelled" && state !== "rejected") throw new PromptAdmissionUnknownError({ cause: result.error, messageID: parameters.messageID });
        }
        return result;
      }, () => new PromptAdmissionUnknownError({ messageID: parameters.messageID }));
    } catch (error) {
      if (preparationRejected && isPromptAdmissionUnknown(error)) {
        throw new Error("Message preparation was rejected before dispatch.", { cause: error });
      }
      if (tracked && parameters.messageID) {
        const state = canReconcile ? await serverPromptAdmission(client, sessionID, parameters.messageID) : "unknown";
        if (state === "accepted") {
          // This is a recorded engine 2xx, never a queued/forwarding ack.
          return { data: {}, request: new Request(`${baseUrl}/session/${encodeURIComponent(sessionID)}/prompt_async`, { method: "POST", headers, body: JSON.stringify(body) }), response: new Response(null, { status: 204 }) };
        }
        if (state === "cancelled" || state === "rejected") {
          if (!isPromptAdmissionUnknown(error)) throw error;
          throw new Error(`Message ${state} before acceptance.`, { cause: error });
        }
        throw new PromptAdmissionUnknownError({ cause: error, messageID: parameters.messageID });
      }
      if (isPromptAdmissionUnknown(error)) {
        throw new PromptAdmissionUnknownError({ cause: error, messageID: parameters.messageID });
      }
      throw error;
    }
  };

  const commandOriginal = sessionOverrides.command.bind(session);
  sessionOverrides.command = (parameters: CommandParameters, options?: { throwOnError?: boolean }) => {
    if (!openworkMount && !("reasoning_effort" in parameters)) {
      return commandOriginal(parameters, options);
    }
    const { sessionID, directory: requestDirectory, ...body } = parameters;
    return postSessionRequest(fetchImpl, baseUrl, `/session/${encodeURIComponent(sessionID)}/command`, body, {
      headers: Object.keys(headers).length ? headers : undefined,
      directory: requestDirectory ?? directory,
      throwOnError: options?.throwOnError,
    });
  };

  return client;
}

/** Includes body consumption: receiving headers alone cannot release a send lock. */
async function withAdmissionDeadline<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>, timeoutError: () => Error): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError());
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function hasAcceptedPromptMessage(client: ReturnType<typeof createClient>, sessionID: string, messageID: string): Promise<boolean> {
  const result = await withAdmissionDeadline(DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS,
    (signal) => client.session.message({ sessionID, messageID }, { signal }),
    () => new Error("Acceptance check timed out. The message is still held."));
  const message = result.data?.info;
  // Absence (including a transient 404) is not proof of rejection.
  return message?.id === messageID && message.sessionID === sessionID && message.role === "user";
}

export type PromptAdmission = "accepted" | "absent" | "unknown";

/** `absent` means authoritative cancellation/rejection, NEVER missing history.
 * A legacy POST can still be behind the server fence despite an idle snapshot. */
export async function readPromptAdmission(client: ReturnType<typeof createClient>, sessionID: string, messageID: string): Promise<PromptAdmission> {
  const state = await serverPromptAdmission(client, sessionID, messageID);
  if (state === "accepted") return "accepted";
  if (state === "cancelled" || state === "rejected") return "absent";
  if (await hasAcceptedPromptMessage(client, sessionID, messageID).catch(() => false)) return "accepted";
  return "unknown";
}

export async function waitForHealthy(
  client: ReturnType<typeof createClient>,
  options?: { timeoutMs?: number; pollMs?: number },
) {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const pollMs = options?.pollMs ?? 250;

  const start = Date.now();
  let lastError: string | null = null;

  while (Date.now() - start < timeoutMs) {
    try {
      const health = unwrap(await client.global.health());
      if (health.healthy) {
        return health;
      }
      lastError = "Server reported unhealthy";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown error";
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(lastError ?? "Timed out waiting for server health");
}
