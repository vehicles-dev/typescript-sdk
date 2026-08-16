import type { InvalidParam } from "./types.js";

export interface VehiclesErrorOptions {
  readonly code: string;
  readonly detail: string;
  readonly invalidParams?: readonly InvalidParam[];
  readonly requestId?: string | null;
  readonly retryAfterSeconds?: number | null;
  readonly retryable: boolean;
  readonly status?: number | null;
  readonly type?: string | null;
}

/** A Vehicles.dev API problem, transport failure, or local workflow failure. */
export class VehiclesError extends Error {
  readonly code: string;
  readonly detail: string;
  readonly invalidParams: readonly InvalidParam[];
  readonly requestId: string | null;
  readonly retryAfterSeconds: number | null;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly type: string | null;

  constructor(options: VehiclesErrorOptions) {
    const status = options.status ?? null;
    const prefix = status === null ? "vehicles.dev error" : `vehicles.dev API error ${status}`;
    super(`${prefix} ${options.code}: ${options.detail}`);
    this.name = "VehiclesError";
    this.code = options.code;
    this.detail = options.detail;
    this.invalidParams = options.invalidParams ?? [];
    this.requestId = options.requestId ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.retryable = options.retryable;
    this.status = status;
    this.type = options.type ?? null;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      detail: this.detail,
      invalidParams: this.invalidParams,
      message: this.message,
      name: this.name,
      requestId: this.requestId,
      retryAfterSeconds: this.retryAfterSeconds,
      retryable: this.retryable,
      status: this.status,
      type: this.type
    };
  }
}
