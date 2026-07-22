import { describe, expect, it } from "vitest";
import { authConfigSchema } from "./auth.js";
import { environmentToFile, storedEnvironmentSchema } from "./collection.js";
import {
  extractTokenRequestAuth,
  shouldRenewTokenRequestAuth,
  TokenRequestAuthFlowError,
  type TokenRequestAuthConfig,
} from "./token-request-auth.js";

const jwtWithExp = (exp: number): string => {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode({ exp })}.`;
};

const parseTokenRequestAuth = (value: unknown): TokenRequestAuthConfig => {
  const auth = authConfigSchema.parse(value);
  if (auth.type !== "tokenRequest") throw new Error("expected tokenRequest");
  return auth;
};

describe("token request auth", () => {
  it("round-trips schema defaults and extracts JWT expiry before other layers", () => {
    const auth = parseTokenRequestAuth({
      type: "tokenRequest",
      requestId: "login",
      expiryResponsePath: "expires_in",
      manualTtlSeconds: 60,
    });
    const token = jwtWithExp(1_700_000_000);

    expect(auth).toEqual({
      type: "tokenRequest",
      requestId: "login",
      accessTokenPath: "access_token",
      refreshTokenPath: "refresh_token",
      accessTokenSecretName: "access_token",
      refreshTokenSecretName: "refresh_token",
      expiryResponsePath: "expires_in",
      manualTtlSeconds: 60,
      renewalMarginSeconds: 30,
    });
    expect(
      extractTokenRequestAuth(
        JSON.stringify({
          access_token: token,
          refresh_token: "refresh-1",
          expires_in: 10,
        }),
        auth,
        1_600_000_000_000
      )
    ).toEqual({
      accessToken: token,
      refreshToken: "refresh-1",
      expiresAt: 1_700_000_000_000,
    });
  });

  it("uses response-field, manual TTL, then unknown expiry and renews only within the margin", () => {
    const now = 1_600_000_000_000;

    expect(
      extractTokenRequestAuth(
        '{"data":{"token":"plain"},"expires_in":45}',
        {
          type: "tokenRequest",
          requestId: "login",
          accessTokenPath: "data.token",
          refreshTokenPath: "",
          accessTokenSecretName: "auth.access",
          refreshTokenSecretName: "auth.refresh",
          expiryResponsePath: "expires_in",
          manualTtlSeconds: 120,
          renewalMarginSeconds: 30,
        },
        now
      ).expiresAt
    ).toBe(now + 45_000);
    expect(
      extractTokenRequestAuth(
        '{"access_token":"plain"}',
        {
          type: "tokenRequest",
          requestId: "login",
          accessTokenPath: "access_token",
          refreshTokenPath: "",
          accessTokenSecretName: "access_token",
          refreshTokenSecretName: "refresh_token",
          expiryResponsePath: "",
          manualTtlSeconds: 120,
          renewalMarginSeconds: 30,
        },
        now
      ).expiresAt
    ).toBe(now + 120_000);
    expect(shouldRenewTokenRequestAuth(now + 31_000, now, 30_000)).toBe(false);
    expect(shouldRenewTokenRequestAuth(now + 30_000, now, 30_000)).toBe(true);
    expect(shouldRenewTokenRequestAuth(null, now, 30_000)).toBe(false);
  });

  it("raises a flow error when extraction yields no access token", () => {
    expect(() =>
      extractTokenRequestAuth(
        '{"token":"missing"}',
        parseTokenRequestAuth({ type: "tokenRequest", requestId: "login" }),
        Date.now()
      )
    ).toThrow(TokenRequestAuthFlowError);
  });

  it("exports configured token secret names without values", () => {
    const env = storedEnvironmentSchema.parse({
      name: "dev",
      vars: {},
      secrets: {
        "auth.access": {
          ref: "red_request_secrets.e_dev.s_access",
          vault: "red_request_secrets",
          configKey: "secret_dev_access",
        },
      },
    });

    expect(environmentToFile(env)).toEqual({
      name: "dev",
      vars: {},
      secretRefs: ["auth.access"],
    });
  });
});
