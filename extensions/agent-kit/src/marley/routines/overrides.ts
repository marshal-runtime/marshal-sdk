// Extract of zygstinct apps/agent-server/src/routines/overrides.ts at 7110e58c8: only RoutineOverrides:declare.
import type Database from "better-sqlite3";
import { z } from "zod";
import { ok } from "../data-tools.js";

export const MAX_KNOWN_NORMAL = 20;

export const MAX_CAPTURE = 12;

export type RoutineFormat = "video" | "text";

export interface RoutineOverride {
  brandId: string;
  routineId: string;
  /** Null: the routine's own default. */
  format: RoutineFormat | null;
  guidance: string | null;
  /** Null: the routine's own default screens. */
  capture: string[] | null;
  knownNormal: string[];
  revision: number;
  updatedBy: string;
  updatedAt: number;
}

export const RoutineOverrideInput = z.strictObject({
  routineId: z.string().min(1).max(64),
  format: z.enum(["video", "text"]).optional(),
  guidance: z.string().max(600).nullable().optional(),
  capture: z.array(z.string().min(1).max(80)).max(MAX_CAPTURE).nullable().optional(),
  knownNormal: z.strictObject({
    add: z.array(z.string().min(1).max(240)).max(5).optional(),
    /** 1-based positions as the list tool shows them. */
    remove: z.array(z.number().int().min(1).max(MAX_KNOWN_NORMAL)).max(10).optional(),
  }).optional(),
});

export type RoutineOverrideInput = z.infer<typeof RoutineOverrideInput>;

/** The stored layer, in the agent server's own database beside the routine registry. */
export declare class RoutineOverrides {
  private readonly db;
  private readonly now;
  constructor(db: Database.Database, now?: () => number);
  get(brandId: string, routineId: string): RoutineOverride | null;
  /** The delivery format the owner chose for a routine, or null for its default. */
format(brandId: string, routineId: string): RoutineFormat | null;
  /** The block every run prompt of the routine ends with: the owner's saved wishes as quoted data. Empty when nothing is saved. */
block(brandId: string, routineId: string): string;
  /**
   * The owner's newer edit of a routine's instructions supersedes the older free-text note on it (a note "no Meta" from last week must not
   * cancel a section asked for today): the note is cleared in a new revision. Returns whether there was a note to clear.
   */
supersedeGuidance(brandId: string, routineId: string, memberId: string): boolean;
  /** Applies one validated change; returns the new row, or a refusal. One transaction: the revision, the rate claim and the row move together. */
apply(brandId: string, memberId: string, input: RoutineOverrideInput): { ok: true; saved: RoutineOverride; changed: string[] } | { ok: false; reason: OverrideRefusal };
}

export type OverrideRefusal = "not-direct-chat" | "no-single-speaker" | "not-member" | "invalid" | "unknown-routine" | "rate-limit" | "too-many";
