import type Database from "better-sqlite3";

import { BRAND_GRAPH_STATE_SCHEMA } from "./brand-graph-state.js";

/** Tables of the schedules module. Created next to the store's own tables; `IF NOT EXISTS` makes a rerun safe. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  cron TEXT,
  at_ms INTEGER,
  timezone TEXT NOT NULL,
  prompt TEXT NOT NULL,
  channel TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  conversation_kind TEXT NOT NULL,
  conversation_title TEXT,
  created_by_member TEXT,
  created_at INTEGER NOT NULL,
  next_run_at INTEGER,
  last_run_at INTEGER,
  fire_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules (status, next_run_at);
CREATE INDEX IF NOT EXISTS schedules_brand ON schedules (brand_id, status);
CREATE TABLE IF NOT EXISTS schedule_fires (
  job_id TEXT NOT NULL,
  scheduled_for INTEGER NOT NULL,
  fired_at INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  message_id TEXT,
  PRIMARY KEY (job_id, scheduled_for)
);
CREATE TABLE IF NOT EXISTS event_subscriptions (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  event TEXT NOT NULL,
  prompt TEXT NOT NULL,
  filter_json TEXT NOT NULL,
  channel TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  conversation_kind TEXT NOT NULL,
  conversation_title TEXT,
  created_by_member TEXT,
  created_at INTEGER NOT NULL,
  fire_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS event_subscriptions_match ON event_subscriptions (brand_id, event, status);
CREATE TABLE IF NOT EXISTS event_subscription_fires (
  subscription_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  fired_at INTEGER NOT NULL,
  message_id TEXT,
  PRIMARY KEY (subscription_id, event_id)
);
CREATE INDEX IF NOT EXISTS event_subscription_fires_brand ON event_subscription_fires (brand_id, fired_at);
CREATE TABLE IF NOT EXISTS events_received (
  brand_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  matched INTEGER NOT NULL DEFAULT 0,
  processed_at INTEGER,
  PRIMARY KEY (brand_id, event_id)
);
CREATE TABLE IF NOT EXISTS withheld_replies (
  turn_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  text TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (turn_id, created_at)
);
`;

export function migrateSchedules(db: Database.Database): void {
  db.exec(SCHEMA);
  // The chain generation a schedule or subscription was made at (tasks/chain.ts): 0 for one a person asked for, which is every row from before it.
  for (const table of ["schedules", "event_subscriptions"]) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
    if (!columns.includes("chain_generation")) db.exec(`ALTER TABLE ${table} ADD COLUMN chain_generation INTEGER NOT NULL DEFAULT 0`);
  }
  // Who a schedule came from: 'operator' for a message a maintainer's approved nudge scheduled (nudges/), else a person's own. nudge_id names the nudge.
  const scheduleColumns = (db.prepare("PRAGMA table_info(schedules)").all() as { name: string }[]).map((column) => column.name);
  if (!scheduleColumns.includes("origin")) db.exec("ALTER TABLE schedules ADD COLUMN origin TEXT NOT NULL DEFAULT 'member'");
  if (!scheduleColumns.includes("nudge_id")) db.exec("ALTER TABLE schedules ADD COLUMN nudge_id TEXT");
  // A one-shot subscription (`once`) ends with its first fire.
  const subscriptionColumns = (db.prepare("PRAGMA table_info(event_subscriptions)").all() as { name: string }[]).map((column) => column.name);
  if (!subscriptionColumns.includes("once")) db.exec("ALTER TABLE event_subscriptions ADD COLUMN once INTEGER NOT NULL DEFAULT 0");
  db.exec(BRAND_GRAPH_STATE_SCHEMA);
}
