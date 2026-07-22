import type { AuthConfig } from "./auth.js";

export class TokenRequestAuthFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenRequestAuthFlowError";
  }
}

export type TokenRequestAuthConfig = Extract<
  AuthConfig,
  { type: "tokenRequest" }
>;

export interface ExtractedTokenRequestAuth {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number | null;
}

function readPath(value: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  let current = value;
  for (const part of trimmed.split(".")) {
    if (!part) return undefined;
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function asToken(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asPositiveSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return undefined;
  return value;
}

function decodeBase64UrlJson(segment: string): unknown {
  const padded = segment.padEnd(
    segment.length + ((4 - (segment.length % 4)) % 4),
    "="
  );
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function tokenRequestJwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const payload = decodeBase64UrlJson(parts[1]);
    const exp =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).exp
        : undefined;
    const seconds = asPositiveSeconds(exp);
    return seconds ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

export function shouldRenewTokenRequestAuth(
  expiresAt: number | null | undefined,
  nowMs = Date.now(),
  marginMs = 30_000
): boolean {
  if (!expiresAt) return false;
  return expiresAt - nowMs <= marginMs;
}

export function extractTokenRequestAuth(
  bodyText: string,
  auth: TokenRequestAuthConfig,
  nowMs = Date.now()
): ExtractedTokenRequestAuth {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new TokenRequestAuthFlowError(
      "Token request auth: login response is not valid JSON"
    );
  }

  const accessToken = asToken(readPath(body, auth.accessTokenPath));
  if (!accessToken) {
    throw new TokenRequestAuthFlowError(
      `Token request auth: no access token at "${auth.accessTokenPath}"`
    );
  }

  const refreshToken = asToken(readPath(body, auth.refreshTokenPath));
  const jwtExpiry = tokenRequestJwtExpiry(accessToken);
  const responseSeconds = asPositiveSeconds(
    readPath(body, auth.expiryResponsePath)
  );
  const manualSeconds = asPositiveSeconds(auth.manualTtlSeconds);
  const expiresAt =
    jwtExpiry ??
    (responseSeconds ? nowMs + responseSeconds * 1000 : null) ??
    (manualSeconds ? nowMs + manualSeconds * 1000 : null);

  return { accessToken, refreshToken, expiresAt };
}
