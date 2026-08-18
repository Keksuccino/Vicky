import { NextResponse } from "next/server";
import { ZodError } from "zod";

export class ApiError extends Error {
  readonly status: number;
  readonly headers?: HeadersInit;

  constructor(status: number, message: string, headers?: HeadersInit) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export const badRequest = (message: string): ApiError => new ApiError(400, message);
export const unauthorized = (message = "Unauthorized"): ApiError => new ApiError(401, message);
export const notFound = (message = "Not found"): ApiError => new ApiError(404, message);

export const parseJsonBody = async <T>(request: Request): Promise<T> => {
  const text = await request.text();
  if (!text.trim()) {
    return {} as T;
  }

  return JSON.parse(text) as T;
};

type BoundedJsonBodyOptions = {
  bodyName: string;
  maxBytes: number;
};

const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i;

export const parseBoundedJsonBody = async <T>(request: Request, options: BoundedJsonBodyOptions): Promise<T> => {
  const contentType = request.headers.get("content-type")?.trim() ?? "";
  if (!JSON_CONTENT_TYPE_PATTERN.test(contentType)) {
    throw new ApiError(415, "Content-Type must be application/json with UTF-8 encoding.");
  }

  const normalizedBodyName = options.bodyName.trim();
  const lowercaseBodyName = normalizedBodyName.toLowerCase();
  const contentEncoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new ApiError(415, `Compressed ${lowercaseBodyName} request bodies are not supported.`);
  }

  const rawContentLength = request.headers.get("content-length");
  let declaredLength: number | null = null;
  if (rawContentLength !== null) {
    const normalizedContentLength = rawContentLength.trim();
    if (!/^\d+$/.test(normalizedContentLength)) {
      throw badRequest("Invalid Content-Length header.");
    }
    declaredLength = Number(normalizedContentLength);
    if (!Number.isSafeInteger(declaredLength)) {
      throw badRequest("Invalid Content-Length header.");
    }
    if (declaredLength > options.maxBytes) {
      throw new ApiError(413, `${normalizedBodyName} request bodies must not exceed ${options.maxBytes} bytes.`);
    }
  }

  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  const reader = request.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > options.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ApiError(413, `${normalizedBodyName} request bodies must not exceed ${options.maxBytes} bytes.`);
      }
      // Copy only the bounded view so a small chunk cannot retain an unexpectedly large
      // shared backing buffer for the rest of request parsing.
      chunks.push(value.slice());
    }
  }

  if (declaredLength !== null && declaredLength !== receivedBytes) {
    throw badRequest(`Content-Length does not match the ${lowercaseBodyName} request body.`);
  }

  const bodyBytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
  } catch {
    throw badRequest(`${normalizedBodyName} request body must be valid UTF-8.`);
  }

  if (!text.trim()) {
    throw badRequest(`${normalizedBodyName} request body is required.`);
  }

  try {
    return JSON.parse(text) as T;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw badRequest(`${normalizedBodyName} request body must be valid JSON.`);
    }
    throw error;
  }
};

export const mergeApiErrorHeaders = (baseHeaders: HeadersInit, error: unknown): Headers => {
  const headers = new Headers(baseHeaders);
  if (error instanceof ApiError) {
    new Headers(error.headers).forEach((value, key) => headers.set(key, value));
  }
  return headers;
};

export const PUBLIC_INTERNAL_ERROR_MESSAGE = "Internal Server Error";

type PublicErrorDetails = {
  headers?: HeadersInit;
  message: string;
  status: number;
};

type ResolvePublicErrorOptions = {
  context: string;
  fallbackMessage?: string;
};

export const PUBLIC_ERROR_LOG_MAX_LENGTH = 2_000;
const MAX_PUBLIC_ERROR_LOG_COMPONENT_LENGTH = 4_096;
const MAX_PUBLIC_ERROR_CAUSE_DEPTH = 4;
const OVERSIZED_PUBLIC_ERROR_LOG_COMPONENT = "[oversized error detail omitted]";
const loggedPublicErrorObjects = new WeakSet<object>();

const redactSensitivePublicErrorLogText = (value: string): string => {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:access[_-]?token|api[_-]?key|auth|authorization|cookie|password|refresh[_-]?token|secret|token)=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/(["']?(?:access[_ -]?token|api[_ -]?key|authorization|cookie|password|proxy-authorization|refresh[_ -]?token|secret|set-cookie|token|x-api-key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-or-v1-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\s{2,}/g, " ")
    .trim();
};

const redactPublicErrorLogComponent = (value: string): string => value.length > MAX_PUBLIC_ERROR_LOG_COMPONENT_LENGTH ? OVERSIZED_PUBLIC_ERROR_LOG_COMPONENT : redactSensitivePublicErrorLogText(value);

const boundRedactedPublicErrorLog = (value: string): string => value.length > PUBLIC_ERROR_LOG_MAX_LENGTH ? `${value.slice(0, PUBLIC_ERROR_LOG_MAX_LENGTH - 1)}…` : value;

const stringifyPublicErrorLogValue = (value: unknown): string => {
  try {
    return String(value);
  } catch {
    return "[unprintable value]";
  }
};

const isErrorInstance = (value: unknown): value is Error => {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
};

const readErrorProperty = (error: Error, property: "cause" | "message" | "name"): unknown => {
  try {
    return Reflect.get(error, property);
  } catch {
    return "[unreadable value]";
  }
};

const formatPublicErrorForLog = (error: unknown, seen = new Set<object>(), depth = 0): string => {
  if (!isErrorInstance(error)) {
    if ((typeof error === "object" && error !== null) || typeof error === "function") {
      // Never stringify arbitrary thrown objects. Provider errors can attach complete
      // request/response objects here, including authorization and cookie headers.
      return `Non-Error throw: [${typeof error}]`;
    }
    return `Non-Error throw: ${redactPublicErrorLogComponent(stringifyPublicErrorLogValue(error))}`;
  }

  if (seen.has(error)) {
    return "[circular error cause]";
  }
  seen.add(error);

  const name = redactPublicErrorLogComponent(stringifyPublicErrorLogValue(readErrorProperty(error, "name"))) || "Error";
  const message = redactPublicErrorLogComponent(stringifyPublicErrorLogValue(readErrorProperty(error, "message"))) || "No error message provided.";
  const formatted = `${name}: ${message}`;
  if (depth >= MAX_PUBLIC_ERROR_CAUSE_DEPTH) {
    return `${formatted} Cause: [cause depth limit reached]`;
  }

  const cause = readErrorProperty(error, "cause");
  return cause === undefined ? formatted : `${formatted} Cause: ${formatPublicErrorForLog(cause, seen, depth + 1)}`;
};

const logUnexpectedPublicError = (context: string, error: unknown): void => {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    if (loggedPublicErrorObjects.has(error)) {
      return;
    }
    loggedPublicErrorObjects.add(error);
  }

  // Pass only a bounded, redacted string to the logger. Passing the original error as
  // another console argument can make runtimes inspect provider-specific headers. The
  // final cut happens only after redaction so it cannot expose a secret fragment.
  const safeContext = redactPublicErrorLogComponent(context);
  // Every dynamic component was already rejected or redacted above, so this final
  // defense-in-depth pass has a strict aggregate input bound even before truncation.
  const diagnostic = redactSensitivePublicErrorLogText(`[public-error] ${safeContext}: ${formatPublicErrorForLog(error)}`);
  console.error(boundRedactedPublicErrorLog(diagnostic));
};

export const resolvePublicError = (error: unknown, options: ResolvePublicErrorOptions): PublicErrorDetails => {
  if (error instanceof ApiError) {
    return {
      headers: error.headers,
      message: error.message,
      status: error.status,
    };
  }

  logUnexpectedPublicError(options.context, error);
  return {
    message: options.fallbackMessage ?? PUBLIC_INTERNAL_ERROR_MESSAGE,
    status: 500,
  };
};

export const publicTextErrorResponse = (error: unknown, options: ResolvePublicErrorOptions & { headers: HeadersInit }): Response => {
  const details = resolvePublicError(error, options);
  return new Response(details.message, {
    status: details.status,
    headers: mergeApiErrorHeaders(options.headers, error),
  });
};

const formatDetailedError = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const parts = [`${error.name || "Error"}: ${error.message || "No error message provided."}`];
  const cause = (error as Error & { cause?: unknown }).cause;

  if (cause !== undefined) {
    parts.push(`Cause: ${formatDetailedError(cause)}`);
  }

  return parts.join(" ");
};

export const errorResponse = (error: unknown, options: { exposeDetails?: boolean } = {}): NextResponse => {
  if (error instanceof ApiError) {
    return NextResponse.json({ error: error.message }, { status: error.status, headers: error.headers });
  }

  if (error instanceof ZodError) {
    return NextResponse.json({ error: error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  }

  if (options.exposeDetails) {
    return NextResponse.json({ error: formatDetailedError(error) }, { status: 500 });
  }

  return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
};
