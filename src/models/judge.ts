// The decide service's multi-question contract: Jev's choice / score / noul questions, plus a native yes/no `predicate`
// and images on the state or on one question. A Jev request is a valid judge request, so older callers are unchanged.
import type { JevAnswer, JevAskRequest, JevAskResult, JevQuestion } from "./jev/api.js";
import { badRequestError } from "./jev/errors.js";

/** An image: a base64 data URL (`data:image/png;base64,...`) or a public http(s) URL, with an optional detail level. */
export type DecideImage = string | { readonly url: string; readonly detail?: "low" | "high" | "auto" | "original" };

export interface NormalizedImage {
  readonly url: string;
  readonly detail?: "low" | "high" | "auto" | "original";
}

export interface PredicateQuestion {
  readonly type: "predicate";
  readonly instructions: unknown;
}

/** A question with, optionally, images shown with that question only (the `decisions` provider). */
export type JudgeQuestion = (JevQuestion | PredicateQuestion) & { readonly images?: readonly DecideImage[] };

export interface JudgeRequest extends Omit<JevAskRequest, "questions"> {
  readonly questions: Readonly<Record<string, JudgeQuestion>>;
  /** Images attached to the state, after its text. */
  readonly images?: readonly DecideImage[];
}

export interface PredicateAnswer {
  readonly type: "predicate";
  /** Probability in [0, 1] that the question's condition holds. */
  readonly probability: number;
}

/** The model declined this one question; the other questions of the request are still answered. */
export interface RefusalAnswer {
  readonly type: "refusal";
}

export type JudgeAnswer = JevAnswer | PredicateAnswer | RefusalAnswer;

export interface JudgeResult extends Omit<JevAskResult, "answers"> {
  readonly answers: Readonly<Record<string, JudgeAnswer>>;
}

const DETAILS = new Set(["low", "high", "auto", "original"]);

/** Validates images before any request: a malformed one is a bad request, never silently dropped. */
export function normalizeImages(images: unknown, where = "images"): NormalizedImage[] {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw badRequestError(`${where} must be a list of image URLs.`);
  return images.map((image, index) => {
    const record = typeof image === "string" ? { url: image } : (image as { url?: unknown; detail?: unknown } | null);
    const url = record && typeof record.url === "string" ? record.url : "";
    if (!/^(data:image\/[a-z0-9.+-]+;base64,|https?:\/\/)/i.test(url)) {
      throw badRequestError(`${where}[${index}] must be a data:image/...;base64 URL or an http(s) URL.`);
    }
    const detail = record?.detail;
    if (detail !== undefined && (typeof detail !== "string" || !DETAILS.has(detail))) {
      throw badRequestError(`${where}[${index}].detail must be low, high, auto or original.`);
    }
    return { url, ...(detail ? { detail: detail as NormalizedImage["detail"] } : {}) };
  });
}
