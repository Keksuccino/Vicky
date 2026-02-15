import { NextResponse } from "next/server";

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

export const errorResponse = (error: unknown): NextResponse => {
  if (error instanceof ApiError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const message = error instanceof Error ? error.message : "Internal Server Error";
  return NextResponse.json({ error: message }, { status: 500 });
};
