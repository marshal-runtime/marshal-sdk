/**
 * Labeled segments of an assembled prompt, for the inspector. A segment names a span of the exact text the model got
 * (`start`/`end` are UTF-16 offsets into it); building them never changes that text.
 */
export const LayerKinds = { Voice: "voice", Rules: "rules", User: "user", State: "state", Prefs: "prefs", Messages: "messages" } as const;
export type LayerKind = (typeof LayerKinds)[keyof typeof LayerKinds];

export interface PromptSegment {
  id: string;
  label: string;
  kind: LayerKind;
  /** Where the text comes from (a file or the function that renders it): developer-facing, never data. */
  source: string;
  start: number;
  end: number;
}

export interface LayerSpec {
  id: string;
  label: string;
  kind: LayerKind;
  source: string;
}

export interface Layered {
  text: string;
  segments: PromptSegment[];
}

/** Builds text and its segments together, so the offsets cannot drift from the text. */
export class Assembler {
  text = "";
  readonly segments: PromptSegment[] = [];

  raw(text: string): this {
    this.text += text;
    return this;
  }

  layer(spec: LayerSpec, text: string): this {
    const start = this.text.length;
    this.text += text;
    this.segments.push({ ...spec, start, end: this.text.length });
    return this;
  }

  /** Appends already-segmented text; its offsets move to where it landed. */
  embed(part: Layered): this {
    const base = this.text.length;
    this.text += part.text;
    for (const segment of part.segments) this.segments.push({ ...segment, start: segment.start + base, end: segment.end + base });
    return this;
  }

  done(): Layered {
    return { text: this.text, segments: [...this.segments].sort((a, b) => a.start - b.start || a.end - b.end) };
  }
}

/** Joins the parts that have text with `separator`, the way `[...].filter(Boolean).join(separator)` does. */
export function joinLayers(parts: ({ spec: LayerSpec; text: string | null } | null)[], separator: string): Layered {
  const assembler = new Assembler();
  let first = true;
  for (const part of parts) {
    if (!part?.text) continue;
    if (!first) assembler.raw(separator);
    first = false;
    assembler.layer(part.spec, part.text);
  }
  return assembler.done();
}

/** True when every segment lies inside the text and none overlaps another. */
export function segmentsFit(text: string, segments: PromptSegment[]): boolean {
  let at = 0;
  for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
    if (!Number.isInteger(segment.start) || !Number.isInteger(segment.end) || segment.start < at || segment.end < segment.start || segment.end > text.length) return false;
    at = segment.end;
  }
  return true;
}

/**
 * Replaces the text of the named layers and returns the new text with every span moved to its place. `applied` lists the ids
 * that were replaced; `absent` the ids this prompt has no layer for (a host context section a resumed turn did not send).
 * Text between layers is untouched.
 */
export function overrideLayers(layered: Layered, overrides: Record<string, string>): { layered: Layered; applied: string[]; absent: string[] } {
  const assembler = new Assembler();
  const applied: string[] = [];
  let cursor = 0;
  for (const segment of [...layered.segments].sort((a, b) => a.start - b.start)) {
    assembler.raw(layered.text.slice(cursor, segment.start));
    const { start: _start, end: _end, ...spec } = segment;
    if (Object.hasOwn(overrides, segment.id)) {
      assembler.layer(spec, overrides[segment.id]!);
      applied.push(segment.id);
    } else assembler.layer(spec, layered.text.slice(segment.start, segment.end));
    cursor = segment.end;
  }
  assembler.raw(layered.text.slice(cursor));
  const present = new Set(layered.segments.map((s) => s.id));
  return { layered: assembler.done(), applied, absent: Object.keys(overrides).filter((id) => !present.has(id)) };
}
