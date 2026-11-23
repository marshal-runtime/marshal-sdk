// Extract of zygstinct apps/agent-server/src/connector-requests.ts at 7110e58c8: only canonical.
/** A name with every separator, space, punctuation mark and diacritic removed, lower case: `Google-Ads`, `google.ads` and `googleads` are the same name. */
export const canonical = (value: string): string => value.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
