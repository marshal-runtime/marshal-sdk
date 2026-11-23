/**
 * Marley platform maintainers (MLY-460, D87): the shapes the channel gateway (the WhatsApp `/brand` command), the web app
 * (brand picker) and the operator CLI share. Tables and rules are in docs/CONTRACTS.md ("Platform maintainers").
 * Types only plus two defaults; env parsing stays with each service (`MAINTAINER_SWITCH_ENABLED` is a gateway setting).
 */

/**
 * How long after the gateway's audited `brand_number_entry` event (MLY-363, D126) a maintainer's own phoneless row in that brand counts as an
 * active member, for the agent server's directory read and the gateway's send check alike.
 */
export const MAINTAINER_ENTRY_HOURS = 4;

/** A web brand context lasts this long after it was set. */
export const MAINTAINER_WEB_CONTEXT_HOURS_DEFAULT = 12;

/** The role a maintainer has in the brand they entered through the web app. Platform level, never a `brand_members.role`. */
export const MAINTAINER_VIEWER_ROLE = "maintainer" as const;

/** The home row of a lease as it was before the lease began (`maintainer_phone_leases.home_restore`), so `/brand off` restores exactly. ISO timestamp or null. */
export interface MaintainerHomeRestore {
  status: "pending" | "active" | "disabled";
  phoneVerifiedAt: string | null;
  channel: "whatsapp" | "imessage" | "sms";
}

/** One row of the `maintainer_brands` view: a brand this maintainer may enter now. */
export interface MaintainerBrand {
  brandId: string;
  brandName: string;
}

/** One numbered line of the `/brand` list. `number` is 1-based and is what `/brand <number>` means for the list the sender last saw. */
export interface MaintainerBrandListEntry extends MaintainerBrand {
  number: number;
  /** The brand whose member row held the phone before any lease. */
  home: boolean;
  /** The brand the phone's messages go to now. */
  current: boolean;
}

export interface MaintainerBrandList {
  brands: MaintainerBrandListEntry[];
  /** Null only when the maintainer has no home brand row (then nothing is listed as switchable). */
  homeBrandId: string | null;
  currentBrandId: string | null;
}

/** What a `/brand ...` message did, for the reply text and the `maintainer_switch` log (ids only). `unavailable` never carries an error text. */
export type MaintainerCommandResult =
  | { kind: "list"; list: MaintainerBrandList }
  | { kind: "switched"; brand: MaintainerBrand; epoch: number }
  | { kind: "already"; brand: MaintainerBrand }
  | { kind: "ambiguous"; candidates: MaintainerBrand[] }
  | { kind: "not_found"; text: string }
  | { kind: "off"; home: MaintainerBrand; from: MaintainerBrand | null; epoch: number }
  | { kind: "help" }
  | { kind: "unavailable" };
