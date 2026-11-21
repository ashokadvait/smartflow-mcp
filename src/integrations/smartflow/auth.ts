import { env } from "../../config/env.js";
import { SmartFlowApiError, UnauthorizedError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";

interface LoginResponse {
  success?: boolean;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

/**
 * Manages Smartflo Bearer tokens.
 * Supports:
 * 1) Portal-generated API token via SMARTFLOW_API_KEY (recommended for quick start).
 * 2) Programmatic JWT via SMARTFLOW_EMAIL + SMARTFLOW_PASSWORD (/v1/auth/login + /v1/auth/refresh).
 */
export class SmartFlowAuthManager {
  private cachedToken: string | null = null;
  private expiresAtMs = 0;

  constructor(
    private readonly baseUrl: string = env.SMARTFLOW_BASE_URL,
    private readonly apiKey: string = env.SMARTFLOW_API_KEY,
    private readonly email: string = env.SMARTFLOW_EMAIL,
    private readonly password: string = env.SMARTFLOW_PASSWORD
  ) {}

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (this.apiKey) {
      return this.apiKey.trim();
    }

    const now = Date.now();
    if (!forceRefresh && this.cachedToken && now < this.expiresAtMs - 60_000) {
      return this.cachedToken;
    }

    if (this.cachedToken && !forceRefresh) {
      try {
        return await this.refreshToken(this.cachedToken);
      } catch (err) {
        logger.warn({ err }, "Smartflo token refresh failed; falling back to login");
      }
    }

    if (!this.email || !this.password) {
      throw new UnauthorizedError(
        "Smartflo credentials missing. Set SMARTFLOW_API_KEY (Portal API Token) or SMARTFLOW_EMAIL + SMARTFLOW_PASSWORD in .env."
      );
    }

    return this.login();
  }

  private async login(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/auth/login`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: this.email, password: this.password }),
    });

    if (!res.ok) {
      throw new SmartFlowApiError(`Smartflo login failed with HTTP ${res.status}`, res.status);
    }

    const body = (await res.json()) as LoginResponse;
    if (!body.access_token) {
      throw new SmartFlowApiError("Smartflo login response did not contain access_token", 500);
    }

    this.cachedToken = body.access_token;
    const ttlSeconds = body.expires_in ?? 3600;
    this.expiresAtMs = Date.now() + ttlSeconds * 1000;
    return this.cachedToken;
  }

  private async refreshToken(currentToken: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/auth/refresh`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${currentToken}`,
      },
    });

    if (!res.ok) {
      throw new SmartFlowApiError(`Smartflo token refresh failed with HTTP ${res.status}`, res.status);
    }

    const body = (await res.json()) as LoginResponse;
    if (!body.access_token) {
      throw new SmartFlowApiError("Smartflo refresh response missing access_token", 500);
    }

    this.cachedToken = body.access_token;
    const ttlSeconds = body.expires_in ?? 3600;
    this.expiresAtMs = Date.now() + ttlSeconds * 1000;
    return this.cachedToken;
  }
}

