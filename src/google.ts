// Google OAuth 2.0 + People API client for Relay's Google Contacts import.
// The user creates an OAuth client in Google Cloud Console (type: Web
// application) with redirect URI http://localhost:3006/api/google/callback
// and enables the People API. Tokens live in gitignored data/config.json.

export class GoogleError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "GoogleError";
  }
}

export interface GoogleSettings {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  email: string;
}

export interface GContact {
  name: string;
  email: string;
  phone: string;
  photo: string;
}

const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";

export function googleAuthUrl(clientId: string, redirectUri: string): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: CONTACTS_SCOPE,
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

async function tokenRequest(body: Record<string, string>): Promise<any> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleError(res.status, `Google sign-in failed: ${j.error_description || j.error || res.status}`);
  return j;
}

export async function exchangeCode(clientId: string, clientSecret: string, code: string, redirectUri: string) {
  const j = await tokenRequest({
    code, client_id: clientId, client_secret: clientSecret,
    redirect_uri: redirectUri, grant_type: "authorization_code",
  });
  if (!j.access_token) throw new GoogleError(0, "Google did not return an access token");
  return j as { access_token: string; refresh_token?: string; expires_in: number };
}

export async function refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string) {
  const j = await tokenRequest({
    refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  if (!j.access_token) throw new GoogleError(0, "Google did not return an access token");
  return j as { access_token: string; expires_in: number };
}

async function peopleGet(accessToken: string, path: string, params: Record<string, string>): Promise<any> {
  const url = `https://people.googleapis.com/v1/${path}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const j: any = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) {
    throw new GoogleError(res.status, "Google rejected the connection — reconnect in Settings.");
  }
  if (!res.ok) throw new GoogleError(res.status, `Google Contacts error: ${j.error?.message || res.status}`);
  return j;
}

/** The Google account's own email address (for the "connected as" label). */
export async function googleAccountEmail(accessToken: string): Promise<string> {
  const j = await peopleGet(accessToken, "people/me", { personFields: "emailAddresses" });
  return j.emailAddresses?.[0]?.value || "";
}

/** All contacts: name, primary email, primary phone, photo. Paginates fully. */
export async function listGoogleContacts(accessToken: string): Promise<GContact[]> {
  const out: GContact[] = [];
  let pageToken = "";
  for (let pages = 0; pages < 20; pages++) {
    const params: Record<string, string> = {
      personFields: "names,emailAddresses,phoneNumbers,photos",
      pageSize: "1000",
    };
    if (pageToken) params.pageToken = pageToken;
    const j = await peopleGet(accessToken, "people/me/connections", params);
    for (const p of j.connections || []) {
      const name = p.names?.find((n: any) => n.metadata?.primary)?.displayName || p.names?.[0]?.displayName || "";
      const email = p.emailAddresses?.find((e: any) => e.metadata?.primary)?.value || p.emailAddresses?.[0]?.value || "";
      const phone = p.phoneNumbers?.find((n: any) => n.metadata?.primary)?.canonicalForm
        || p.phoneNumbers?.find((n: any) => n.metadata?.primary)?.value
        || p.phoneNumbers?.[0]?.canonicalForm || p.phoneNumbers?.[0]?.value || "";
      if (!name && !email) continue;
      out.push({ name, email, phone, photo: p.photos?.[0]?.url || "" });
    }
    pageToken = j.nextPageToken || "";
    if (!pageToken) break;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
