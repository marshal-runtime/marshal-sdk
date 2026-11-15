import type { PermissionCheck } from "@marshal/runtime/core";

const MAX_LISTED_FIELDS = 12;

export class CapabilityInputError extends Error {
  readonly code = "invalid_request";

  constructor(message: string) {
    super(message);
    this.name = "CapabilityInputError";
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quoted(names: readonly string[]): string {
  const shown = names.slice(0, MAX_LISTED_FIELDS).map((name) => `"${name}"`);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * Catches the calls a provider cannot act on — a missing required field, or a
 * non-object where the schema declares an object — before the provider runs, so
 * the caller gets an error naming the field instead of a provider-specific
 * failure. Deliberately narrower than full JSON Schema validation: unknown
 * fields alone are not rejected (many providers tolerate them), only named in
 * the message when the call is rejected for another reason.
 */
export function assertCapabilityInput(
  capability: PermissionCheck["capability"],
  input: unknown,
): void {
  const schema = capability.inputSchema;
  if (!isRecord(schema) || schema.type !== "object") return;
  if (input !== undefined && input !== null && !isRecord(input)) {
    throw new CapabilityInputError(
      `Input for "${capability.name}" must be a JSON object matching its inputSchema.`,
    );
  }
  const fields = isRecord(input) ? input : {};
  const required = stringList(schema.required);
  const missing = required.filter((name) => fields[name] === undefined);
  if (missing.length === 0) return;

  const properties = isRecord(schema.properties) ? Object.keys(schema.properties) : [];
  const unexpected =
    schema.additionalProperties === false && !isRecord(schema.patternProperties)
      ? Object.keys(fields).filter((name) => !properties.includes(name))
      : [];
  const expected = properties.map((name) =>
    required.includes(name) ? `${name} (required)` : name,
  );
  const message = [
    `Input for "${capability.name}" is missing required field${missing.length === 1 ? "" : "s"} ${quoted(missing)}.`,
    unexpected.length > 0
      ? `Field${unexpected.length === 1 ? "" : "s"} ${quoted(unexpected)} ${unexpected.length === 1 ? "is" : "are"} not part of its inputSchema.`
      : "",
    expected.length > 0
      ? `Expected fields: ${expected.slice(0, MAX_LISTED_FIELDS).join(", ")}${expected.length > MAX_LISTED_FIELDS ? ", …" : ""}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  throw new CapabilityInputError(message);
}
