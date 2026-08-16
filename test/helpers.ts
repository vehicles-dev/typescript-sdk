import { vi } from "vitest";

export const API_KEY = "unit-test-api-key";
export const VIN = "1HGCM82633A004352";
export const REPORT_ID = "11111111-1111-4111-8111-111111111111";
export const IDEMPOTENCY_KEY = "22222222-2222-4222-8222-222222222222";

export interface FetchCall {
  readonly init: RequestInit | undefined;
  readonly url: string;
}

export function jsonResponse(
  body: unknown,
  init: ResponseInit & { readonly headers?: HeadersInit } = {}
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function problemResponse(
  body: Record<string, unknown>,
  init: ResponseInit & { readonly headers?: HeadersInit }
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/problem+json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function fetchSequence(...responses: Array<Response | Error>): {
  readonly calls: FetchCall[];
  readonly fetch: typeof fetch;
} {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    calls.push({ init, url: input instanceof Request ? input.url : String(input) });
    const next = queue.shift();
    if (next === undefined) throw new Error("Unexpected fetch call");
    if (next instanceof Error) throw next;
    return next;
  });
  return { calls, fetch };
}

export function successfulFetch(body: unknown = {}): {
  readonly calls: FetchCall[];
  readonly fetch: typeof fetch;
} {
  const calls: FetchCall[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    calls.push({ init, url: input instanceof Request ? input.url : String(input) });
    return jsonResponse(body);
  });
  return { calls, fetch };
}
