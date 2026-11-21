import { env } from "../../config/env.js";
import { formatForSmartfloQuery } from "../../utils/dates.js";
import { SmartFlowApiError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { SmartFlowAuthManager } from "./auth.js";
import { mapSmartfloCallRecord, mapSmartfloUser } from "./mappers.js";
import type {
  SmartFlowAgent,
  SmartFlowCall,
  SmartfloCdrPageResponse,
  SmartfloRawUser,
} from "./types.js";

export interface GetCallsParams {
  from: Date;
  to: Date;
  page?: number;
  limit?: number;
  timezone?: string;
}

export interface GetCallsResult {
  calls: SmartFlowCall[];
  page: number;
  limit: number;
  totalCount: number;
  hasMore: boolean;
}

export class SmartFlowClient {
  private readonly baseUrl: string;
  private readonly auth: SmartFlowAuthManager;
  private readonly minIntervalMs: number;
  private lastRequestAt = 0;

  constructor(options: { baseUrl?: string; auth?: SmartFlowAuthManager; rps?: number } = {}) {
    this.baseUrl = (options.baseUrl ?? env.SMARTFLOW_BASE_URL).replace(/\/+$/, "");
    this.auth = options.auth ?? new SmartFlowAuthManager(this.baseUrl);
    const rps = options.rps ?? env.SMARTFLOW_RATE_LIMIT_RPS;
    this.minIntervalMs = Math.ceil(1000 / Math.max(1, rps));
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = this.lastRequestAt + this.minIntervalMs - now;
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastRequestAt = Date.now();
  }

  async request<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== "") {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.throttle();
      const token = await this.auth.getAccessToken(attempt > 1);

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });

      if (response.ok) {
        return (await response.json()) as T;
      }

      const bodyText = await response.text().catch(() => "");
      const err = new SmartFlowApiError(
        `Smartflo API error ${response.status} on ${path}: ${bodyText.slice(0, 300)}`,
        response.status
      );
      lastError = err;

      // Retry on 401 (once, in case JWT expired) or 429/5xx
      const shouldRetry =
        attempt < maxAttempts && (response.status === 401 || response.status === 429 || response.status >= 500);
      if (!shouldRetry) {
        throw err;
      }

      const backoffMs = 500 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250);
      logger.warn({ path, status: response.status, attempt, backoffMs }, "Retrying Smartflo API request");
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }

    throw lastError;
  }

  /**
   * Fetch a single page of Call Detail Records (CDR) from GET /v1/call/records.
   */
  async getCallsPage(params: GetCallsParams): Promise<GetCallsResult> {
    const page = params.page ?? 1;
    const limit = Math.min(params.limit ?? 100, 100);
    const timezone = params.timezone ?? env.DEFAULT_TIMEZONE;

    const data = await this.request<SmartfloCdrPageResponse>("/call/records", {
      from_date: formatForSmartfloQuery(params.from, timezone),
      to_date: formatForSmartfloQuery(params.to, timezone),
      page,
      limit,
    });

    const rawRecords = data.results ?? data.data ?? [];
    const calls = rawRecords.map((r) => mapSmartfloCallRecord(r, timezone));
    const totalCount = data.count ?? calls.length;
    const hasMore = page * limit < totalCount && rawRecords.length > 0;

    return { calls, page, limit, totalCount, hasMore };
  }

  /**
   * Fetch all Call Detail Records across pages for a bounded date range.
   */
  async getAllCalls(params: { from: Date; to: Date; timezone?: string; maxPages?: number }): Promise<SmartFlowCall[]> {
    const all: SmartFlowCall[] = [];
    const maxPages = params.maxPages ?? 100;
    let page = 1;

    while (page <= maxPages) {
      const res = await this.getCallsPage({
        from: params.from,
        to: params.to,
        page,
        limit: 100,
        timezone: params.timezone,
      });
      all.push(...res.calls);
      if (!res.hasMore) break;
      page += 1;
    }

    return all;
  }

  /**
   * Fetch users/agents from GET /v1/users using last_seen_id pagination.
   */
  async getAgents(): Promise<SmartFlowAgent[]> {
    const agents: SmartFlowAgent[] = [];
    let lastSeenId: number | undefined;
    const limit = 100;

    for (let page = 0; page < 50; page++) {
      const res = await this.request<{ results?: SmartfloRawUser[]; data?: SmartfloRawUser[] } | SmartfloRawUser[]>(
        "/users",
        { limit, last_seen_id: lastSeenId }
      );

      const list = Array.isArray(res) ? res : (res.results ?? res.data ?? []);
      if (list.length === 0) break;

      for (const raw of list) {
        agents.push(mapSmartfloUser(raw));
      }

      if (list.length < limit) break;
      const lastItem = list[list.length - 1];
      const numericId = Number(lastItem?.id);
      if (!Number.isFinite(numericId) || numericId === lastSeenId) break;
      lastSeenId = numericId;
    }

    return agents;
  }
}

