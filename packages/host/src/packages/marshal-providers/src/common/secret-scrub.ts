import { redactSecrets } from "./secret-redactor";

const PEM_PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|(?:(?:\r?\n|\\n)[A-Za-z0-9+/=]{16,})*)/g;

/** Removes tokens, bearer credentials and credential assignments from text; paths are left alone. */
export function scrubSecrets(text: string): string {
  let result = redactSecrets(text).result;
  result = result.replace(PEM_PRIVATE_KEY_PATTERN, "[REDACTED:private-key]");
  result = result.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{20,}=*/gi, "$1 [REDACTED:bearer]");
  result = result.replace(
    /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
    "$1[REDACTED:credential]",
  );
  return result;
}
