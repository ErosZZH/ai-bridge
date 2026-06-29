// GitHub OAuth device flow (RFC 8628). Lets `ai-bridge login` mint its own
// Copilot-capable oauth_token instead of borrowing one from VS Code / `gh`.
// Pure functions over an injected fetch + sleep so the polling loop is unit
// testable without real network or wall-clock delays.

import { CopilotAuthError, USER_AGENT } from "./index.js";

// VS Code Copilot's classic OAuth-app client id. This is the id GitHub's device
// endpoint accepts for a token that subsequently exchanges at
// copilot_internal/v2/token. (App-style Iv23.../Ov23... ids do NOT work here.)
export const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
// Copilot entitlement rides on the account, not the OAuth scope, so the minimal
// scope that still resolves the username is enough.
const SCOPE = "read:user";

export type Sleep = (seconds: number) => Promise<void>;

export const realSleep: Sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

export type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number; // seconds between polls
  expiresIn: number; // seconds until deviceCode is dead
};

function ghHeaders(): Record<string, string> {
  return { Accept: "application/json", "User-Agent": USER_AGENT };
}

export async function requestDeviceCode(fetchImpl: typeof fetch): Promise<DeviceCode> {
  const res = await fetchImpl(DEVICE_CODE_URL, {
    method: "POST",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, scope: SCOPE }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new CopilotAuthError(
      `device code request failed: ${res.status} ${res.statusText} ${body}`.trim(),
      res.status,
    );
  }
  const data = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    interval?: number;
    expires_in?: number;
  };
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new CopilotAuthError("device code response missing fields");
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    interval: data.interval ?? 5,
    expiresIn: data.expires_in ?? 900,
  };
}

// Poll the access-token endpoint until the user authorizes, the code expires,
// or they deny. Honors slow_down by lengthening the interval. Elapsed time is
// tracked by summing the sleeps we issue — no Date.now(), which keeps this
// deterministic under an injected sleep in tests.
export async function pollForToken(
  fetchImpl: typeof fetch,
  sleep: Sleep,
  code: DeviceCode,
): Promise<string> {
  let interval = code.interval;
  let elapsed = 0;
  while (elapsed < code.expiresIn) {
    await sleep(interval);
    elapsed += interval;

    const res = await fetchImpl(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { ...ghHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: COPILOT_CLIENT_ID,
        device_code: code.deviceCode,
        grant_type: GRANT_TYPE,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
      interval?: number;
    };

    if (data.access_token) return data.access_token;

    switch (data.error) {
      case "authorization_pending":
        break;
      case "slow_down":
        // GitHub asks us to back off; use its suggested interval or add 5s.
        interval = data.interval ?? interval + 5;
        break;
      case "expired_token":
        throw new CopilotAuthError("device code expired before authorization; run `ai-bridge login` again");
      case "access_denied":
        throw new CopilotAuthError("authorization denied");
      default:
        throw new CopilotAuthError(`device flow error: ${data.error ?? "unknown"}`);
    }
  }
  throw new CopilotAuthError("device code expired before authorization; run `ai-bridge login` again");
}

// Best-effort username for the on-disk `user` field. Never fatal — the token is
// what matters; the name is cosmetic.
export async function fetchGitHubUser(
  fetchImpl: typeof fetch,
  accessToken: string,
): Promise<string> {
  try {
    const res = await fetchImpl(USER_URL, {
      headers: { ...ghHeaders(), Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return "unknown";
    const data = (await res.json()) as { login?: string };
    return data.login ?? "unknown";
  } catch {
    return "unknown";
  }
}
