import { APP_VERSION } from "../version";
import {
  AckItem,
  AckResponse,
  HeartbeatPrinter,
  InProgressItem,
  PairResponse,
  SyncResponse,
} from "./types";

/**
 * HTTP client for the Laravel Print Service v2 API.
 * Uses Node's built-in fetch: TLS certificates ARE verified (no "ignore SSL" option exists here).
 * The device token is sent only in the Authorization header, never in the URL.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Network problem or server error (5xx/429): try again later. */
  get isTemporary(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

export interface ApiClientOptions {
  serverUrl: string;
  token?: string | null;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ApiClientOptions) {
    this.baseUrl = options.serverUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  withToken(token: string): ApiClient {
    return new ApiClient({ ...this.options, token });
  }

  async pair(body: { code: string; device_name: string; machine_id?: string; app_version?: string; os_info?: string }): Promise<PairResponse> {
    return this.json<PairResponse>("POST", "/api/print/v2/pair", body, false);
  }

  async sync(inProgress: InProgressItem[]): Promise<SyncResponse> {
    return this.json<SyncResponse>("POST", "/api/print/v2/sync", { in_progress: inProgress });
  }

  async ack(acks: AckItem[]): Promise<AckResponse> {
    return this.json<AckResponse>("POST", "/api/print/v2/ack", { acks });
  }

  async heartbeat(body: { app_version: string; os_info?: string; printers: HeartbeatPrinter[]; [key: string]: unknown }): Promise<void> {
    await this.json("POST", "/api/print/v2/heartbeat", body);
  }

  async checkUpdate(currentVersion: string): Promise<import("../update").UpdateInfo> {
    return this.json("GET", `/api/print/v2/update?version=${encodeURIComponent(currentVersion)}`);
  }

  /**
   * Download a print image. The URL comes from the server; it must be on the same server
   * (the token must never be sent to another host).
   */
  async downloadContent(contentUrl: string): Promise<Buffer> {
    const url = this.resolveSameOrigin(contentUrl);
    const response = await this.request("GET", url, undefined, true, "image/png");
    if (!response.ok) {
      throw await this.toApiError(response);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private async json<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const response = await this.request(method, this.baseUrl + path, body, auth, "application/json");
    if (!response.ok) {
      throw await this.toApiError(response);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiError(`Server returned invalid JSON for ${path}`, response.status);
    }
  }

  private async request(method: string, url: string, body: unknown, auth: boolean, accept: string): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: accept,
      "User-Agent": `FoodMonsterPrint/${APP_VERSION}`,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (auth) {
      if (!this.options.token) {
        throw new ApiError("This device is not paired yet.", 401, "NOT_PAIRED");
      }
      headers.Authorization = `Bearer ${this.options.token}`;
    }

    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
        redirect: "error", // never follow redirects with our token
      });
    } catch (error) {
      const reason = describeFetchError(error);
      throw new ApiError(`Cannot reach server ${this.baseUrl}: ${reason}`, 0, "NETWORK");
    }
  }

  private async toApiError(response: Response): Promise<ApiError> {
    let message = `HTTP ${response.status}`;
    let errorCode: string | null = null;
    try {
      const data = (await response.json()) as { message?: string; error_code?: string };
      if (data?.message) {
        message = `${message}: ${data.message}`;
      }
      errorCode = data?.error_code ?? null;
    } catch {
      // body is not JSON
    }
    return new ApiError(message, response.status, errorCode);
  }

  private resolveSameOrigin(contentUrl: string): string {
    const base = new URL(this.baseUrl);
    const url = new URL(contentUrl, base);
    if (url.origin !== base.origin) {
      throw new ApiError(`Refusing to download from another server: ${url.origin}`, 0, "BAD_CONTENT_URL");
    }
    return url.toString();
  }
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "timeout";
    }
    const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code) {
      // e.g. CERT_HAS_EXPIRED, UNABLE_TO_VERIFY_LEAF_SIGNATURE, ENOTFOUND, ECONNREFUSED
      return `${cause.code}${cause.message ? " (" + cause.message + ")" : ""}`;
    }
    return error.message;
  }
  return String(error);
}
