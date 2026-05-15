import { NextResponse } from "next/server";
import { ZodError } from "zod";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  if (error instanceof ZodError) {
    return NextResponse.json({ error: error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  }

  if (options.exposeDetails) {
    return NextResponse.json({ error: formatDetailedError(error) }, { status: 500 });
  }

  return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
};
