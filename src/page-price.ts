// A product pack whose offers have no price gets one before Page Studio reads it: first from the store's public
// product JSON (/products/<handle>.js, read-only), else from the brand's own site screenshots in the pack, read by one
// small model look. Page Studio reads offers.json from the pack folder it learns, so the run hands it a copy of the
// product pack with the price filled and its source named, and the input pack itself is never changed.
import fs from "node:fs";
import https from "node:https";
import path from "node:path";

export interface Offer {
  shopify_variant_id?: string | null;
  title?: string;
  price?: number | null;
  price_source?: string;
  [key: string]: unknown;
}

export interface OffersFile {
  domain?: string;
  product_page_url?: string;
  offers?: Offer[];
  warnings?: string[];
  [key: string]: unknown;
}

export type GetJson = (url: string) => Promise<{ status: number; body: unknown }>;
/** Reads a price for `product` off the screenshot files (absolute paths); resolves undefined when none is visible. */
export type ScreenshotLook = (product: string, files: string[]) => Promise<{ price: number; file: string } | undefined>;

export interface PricedPack {
  /** The product pack folder Page Studio should learn: the input's, or a copy with the price filled. */
  productDir: string;
  /** Where the price came from, when one was filled. */
  source?: string;
  warnings: string[];
}

export function missingPrice(offers: OffersFile): boolean {
  return Array.isArray(offers.offers) && offers.offers.length > 0 && offers.offers.every((offer) => offer.price == null);
}

/** The store's own price of each offer's variant (Shopify's .js JSON carries cents). */
export async function storePrices(domain: string, handle: string, get: GetJson): Promise<Map<string, number> | undefined> {
  if (!domain || !/^[a-z0-9][a-z0-9_-]*$/i.test(handle)) return undefined;
  const answer = await get(`https://${domain}/products/${handle}.js`).catch(() => undefined);
  const variants = answer?.status === 200 ? (answer.body as { variants?: { id?: unknown; price?: unknown }[] })?.variants : undefined;
  if (!Array.isArray(variants) || !variants.length) return undefined;
  const prices = new Map<string, number>();
  for (const variant of variants) {
    if (typeof variant.price === "number") prices.set(String(variant.id), variant.price / 100);
  }
  return prices.size ? prices : undefined;
}

export async function pricedPack(options: {
  productDir: string;
  /** The input folder (brand/site/ holds the site screenshots). */
  inputDir: string;
  /** Where the filled copy goes (inside the run's state folder). */
  copyDir: string;
  handle: string;
  productName: string;
  get?: GetJson;
  look?: ScreenshotLook;
  log?: (line: string) => void;
}): Promise<PricedPack> {
  const offersFile = path.join(options.productDir, "offers.json");
  let offers: OffersFile;
  try {
    offers = JSON.parse(fs.readFileSync(offersFile, "utf8")) as OffersFile;
  } catch {
    return { productDir: options.productDir, warnings: [] };
  }
  if (!missingPrice(offers)) return { productDir: options.productDir, warnings: [] };
  const warnings: string[] = [];
  const domain = String(offers.domain ?? "");
  let source: string | undefined;
  let filled: Offer[] | undefined;
  const store = await storePrices(domain, options.handle, options.get ?? getJson);
  if (store) {
    filled = offers.offers!.map((offer) => {
      const price = store.get(String(offer.shopify_variant_id ?? "")) ?? (store.size === 1 ? [...store.values()][0] : undefined);
      return price === undefined ? offer : { ...offer, price, price_source: `the store's /products/${options.handle}.js` };
    });
    if (filled.some((offer) => offer.price != null)) source = `https://${domain}/products/${options.handle}.js`;
  } else {
    warnings.push(`price: the store has no public product JSON for ${options.handle} (https://${domain}/products/${options.handle}.js)`);
  }
  if (!source && options.look) {
    const siteDir = path.join(options.inputDir, "brand", "site");
    const shots = fs.existsSync(siteDir)
      ? fs.readdirSync(siteDir).filter((name) => /\.(png|jpe?g|webp)$/i.test(name)).map((name) => path.join(siteDir, name))
      : [];
    const seen = shots.length && offers.offers!.length === 1 ? await options.look(options.productName, shots).catch((error) => {
      warnings.push(`price: the screenshot look failed (${error instanceof Error ? error.message : String(error)})`);
      return undefined;
    }) : undefined;
    if (seen) {
      const relative = path.relative(options.inputDir, seen.file);
      source = `the brand's site screenshot ${relative}`;
      filled = offers.offers!.map((offer) => ({ ...offer, price: seen.price, price_source: `seen on the brand's site screenshot ${relative}` }));
    }
  }
  if (!source || !filled) {
    warnings.push("price: no grounded price found; the page shows none");
    return { productDir: options.productDir, warnings };
  }
  fs.rmSync(options.copyDir, { recursive: true, force: true });
  fs.cpSync(options.productDir, options.copyDir, { recursive: true });
  const priced: OffersFile = {
    ...offers,
    offers: filled,
    warnings: [...(offers.warnings ?? []), `the price was missing from the store data; filled from ${source}`],
  };
  fs.writeFileSync(path.join(options.copyDir, "offers.json"), JSON.stringify(priced, null, 2));
  options.log?.(`price ${filled.map((offer) => offer.price).join(", ")} from ${source}`);
  return { productDir: options.copyDir, source, warnings };
}

export function getJson(url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { accept: "application/json", "user-agent": "marshal-sdk page-run" }, timeout: 15_000 }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          body = undefined;
        }
        resolve({ status: response.statusCode ?? 0, body });
      });
    });
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", reject);
  });
}

/** One small Claude look at the site screenshots: the product's price as shown there, or none. */
export function claudeScreenshotLook(env: Record<string, string>, model = "claude-haiku-5-5"): ScreenshotLook {
  return async (product, files) => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const prompt = [
      `These are screenshots of a brand's own website. Read each one with the Read tool, then tell me the price the site shows for this product: ${product}.`,
      "Only a price printed next to that product counts (not another product's, not a shipping threshold, not a crossed-out price).",
      'Answer with JSON only: {"price": <number in the store currency, e.g. 48.0>, "file": "<the screenshot path it is on>"}, or {"price": null} when no screenshot shows it.',
      "",
      ...files,
    ].join("\n");
    let text = "";
    for await (const message of query({
      prompt,
      options: { model, allowedTools: ["Read"], tools: ["Read"], permissionMode: "bypassPermissions", settingSources: [], maxTurns: files.length + 3, env, cwd: path.dirname(files[0]!) },
    } as Parameters<typeof query>[0])) {
      if (message.type === "result" && message.subtype === "success") text = message.result;
    }
    const json = /\{[\s\S]*\}/.exec(text)?.[0];
    if (!json) return undefined;
    const answer = JSON.parse(json) as { price?: unknown; file?: unknown };
    if (typeof answer.price !== "number" || !(answer.price > 0)) return undefined;
    const file = files.find((candidate) => candidate === answer.file || path.basename(candidate) === path.basename(String(answer.file ?? ""))) ?? files[0]!;
    return { price: answer.price, file };
  };
}
