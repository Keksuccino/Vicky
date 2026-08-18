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
