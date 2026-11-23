export const CONNECTOR_PROVIDERS = [
  "shopify",
  "meta_ads",
  "meta_access",
  "google_ads",
  "tiktok_ads",
  "klaviyo",
  "gorgias",
  "intercom",
  "triple_whale",
  "recharge",
  "amazon_seller",
  "amazon_ads",
  "applovin",
  "yotpo",
  "monday",
  "flashy",
  "posthog",
  "google_drive",
  "google_workspace",
  "google_workspace_actions",
  "google_footage",
  "shopify_reports",
  "taboola",
] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

export const CONNECTION_STATUSES = ["pending", "connected", "failed", "broken"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];
