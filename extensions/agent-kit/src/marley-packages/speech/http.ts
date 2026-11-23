import { GoogleAuth } from "google-auth-library";
import { SpeechError } from "./types.js";

export type FetchLike = typeof fetch;
export type TokenProvider = () => Promise<string>;

/** Access tokens from Application Default Credentials (the service account on Cloud Run, or gcloud ADC locally). */
export function adcTokenProvider(): TokenProvider {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  return async () => {
    const token = await auth.getAccessToken();
    if (!token) throw new SpeechError("auth", "Application Default Credentials returned no access token");
    return token;
  };
}

/** Turns a failed Google API response into a SpeechError. */
export async function failFromResponse(res: Response, what: string): Promise<never> {
  const body = await res.text().catch(() => "");
  let message = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; status?: string } };
    if (parsed.error?.message) message = parsed.error.message;
  } catch {
    // keep the raw text
  }
  const disabled = res.status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(body);
  const code = disabled ? "api-disabled" : res.status === 401 || res.status === 403 ? "auth" : "provider-error";
  throw new SpeechError(code, `${what} failed (${res.status}): ${message}`, res.status);
}

/** fetch with a deadline. A hung provider call becomes a SpeechError("timeout") instead of waiting forever. */
export async function timedFetch(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number, what: string): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new SpeechError("timeout", `${what} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  }
}
