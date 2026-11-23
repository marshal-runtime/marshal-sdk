// Extract of zygstinct apps/agent-server/src/ua-figures.ts at 7110e58c8: only UaFigures:declare.
import type Database from "better-sqlite3";
import { z } from "zod";

const currency = z.string().regex(/^[A-Z]{3}$/);

const text = (max: number) => z.string().min(1).max(max);

const Theme = z.object({
  id: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/),
  kind: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/),
  headline: text(240),
  move: text(400),
  why: text(600),
  moneyAtStake: z.object({ amount: z.number().finite().min(0).max(1e7), currency, basis: text(160) }).strict().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  needsOwner: z.boolean(),
}).strict();

export type UaTheme = z.infer<typeof Theme>;

export interface UaAnalysis { analysisDate: string; dataThrough: string; currency: string | null; stale: boolean; themes: UaTheme[]; briefText: string }

export interface StoredFigures { analysis: (UaAnalysis & { capturedAt: number }) | null; target: { value: number; at: number } | null }

export declare class UaFigures {
  private readonly db;
  private readonly now;
  constructor(db: Database.Database, now?: () => number);
  putAnalysis(brandId: string, memberId: string, analysis: UaAnalysis, at?: number, keepThemes?: any): void;
  putTarget(brandId: string, memberId: string, target: number | null, at?: number): void;
  /** What is still within 48 hours for this brand and member. An expired half is erased when read. */
get(brandId: string, memberId: string, at?: number): StoredFigures;
  has(brandId: string, memberId: string, at?: number): boolean;
  private prune;
}

type Json = Record<string, unknown>;

const object = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null);

function amount(value: { amount: number; currency: string }): string {
  return `${value.currency} ${Number.isInteger(value.amount) ? value.amount : value.amount.toFixed(2)}`;
}
