// Lifted from packages/speech/src/http.ts (zygstinct 940a0c6d5) so every SDK host gets Marley's speech providers natively.
import { googleAccessTokenProvider, type AccessTokenProvider } from "../credentials.js";
import { SpeechError } from "./types.js";

export type FetchLike = typeof fetch;
export type TokenProvider = () => Promise<string>;

/** Access tokens from Application Default Credentials (the service account on Cloud Run, or gcloud ADC locally). */
export function adcTokenProvider(token: AccessTokenProvider = googleAccessTokenProvider()): TokenProvider {
  return async () => {
    try {
      return await token();
    } catch (error) {
      throw new SpeechError("auth", error instanceof Error ? error.message : "Application Default Credentials returned no access token");
    }
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
