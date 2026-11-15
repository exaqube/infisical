import { request } from "../config/request";

// Instance-wide "Continue with SSO" login against one OpenID Connect provider, configured by env
// (OIDC_LOGIN_ISSUER, CLIENT_ID_OIDC_LOGIN, CLIENT_SECRET_OIDC_LOGIN). It rides on the same
// oauth2Login path as Google/GitHub/GitLab login, so password login keeps working next to it.

export type TOidcLoginMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
};

export type TOidcUserInfo = {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  given_name?: unknown;
  family_name?: unknown;
  name?: unknown;
};

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

let cachedMetadata: TOidcLoginMetadata | null = null;

export const getCachedOidcLoginMetadata = () => cachedMetadata;

export const discoverOidcLoginMetadata = async (issuer: string): Promise<TOidcLoginMetadata> => {
  const base = issuer.replace(/\/+$/, "");
  const { data } = await request.get<TOidcLoginMetadata>(`${base}/.well-known/openid-configuration`);

  for (const key of ["authorization_endpoint", "token_endpoint", "userinfo_endpoint"] as const) {
    if (!str(data?.[key]).startsWith("https://")) {
      throw new Error(`OIDC login: discovery document for ${base} has no https ${key}`);
    }
  }
  // Discovery must describe the configured issuer, or a misconfigured URL could point login at another provider.
  if (str(data.issuer).replace(/\/+$/, "") !== base) {
    throw new Error(`OIDC login: discovery issuer ${str(data.issuer)} does not match ${base}`);
  }

  cachedMetadata = data;
  return data;
};

export const fetchOidcUserInfo = async (userinfoEndpoint: string, accessToken: string) => {
  const { data } = await request.get<TOidcUserInfo>(userinfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return data;
};

/**
 * Map userinfo claims to oauth2Login input. Returns null when the provider gives no subject or email.
 * isEmailVerifiedByProvider is true only for a real JSON boolean true: oauth2Login links the login to
 * an existing account by email only when the provider vouches for that email, so anything else must
 * fall back to Infisical's own verification (the safe direction).
 */
export const mapOidcUserInfo = (info: TOidcUserInfo) => {
  const sub = str(info.sub);
  const email = str(info.email).toLowerCase();
  if (!sub || !email) return null;

  let firstName = str(info.given_name);
  let lastName = str(info.family_name);
  if (!firstName && !lastName) {
    const parts = str(info.name).split(/\s+/).filter(Boolean);
    firstName = parts[0] ?? "";
    lastName = parts.slice(1).join(" ");
  }

  return {
    providerUserId: sub,
    email,
    firstName: firstName || email.split("@")[0],
    lastName,
    isEmailVerifiedByProvider: info.email_verified === true
  };
};
