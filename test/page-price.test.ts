import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { missingPrice, pricedPack, storePrices, type GetJson } from "../src/page-price.js";

function input(offers: unknown): { inputDir: string; productDir: string } {
  const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "price-"));
  const productDir = path.join(inputDir, "products", "1");
  fs.mkdirSync(productDir, { recursive: true });
  fs.mkdirSync(path.join(inputDir, "brand", "site"), { recursive: true });
  fs.writeFileSync(path.join(inputDir, "brand", "site", "q1.png"), "png");
  fs.writeFileSync(path.join(productDir, "offers.json"), JSON.stringify(offers));
  fs.writeFileSync(path.join(productDir, "facts.md"), "- C1: a fact\n");
  return { inputDir, productDir };
}

const OFFERS = { domain: "shop.example", offers: [{ shopify_variant_id: "11", title: "Default Title", price: null }] };

test("missingPrice: only when every offer lacks one", () => {
  assert.equal(missingPrice(OFFERS), true);
  assert.equal(missingPrice({ offers: [{ price: 48 }] }), false);
  assert.equal(missingPrice({ offers: [] }), false);
});

test("storePrices reads the variant prices of the public product JSON (cents to units)", async () => {
  const get: GetJson = async (url) => {
    assert.equal(url, "https://shop.example/products/cream.js");
    return { status: 200, body: { variants: [{ id: 11, price: 4800 }, { id: 12, price: 9000 }] } };
  };
  assert.deepEqual([...(await storePrices("shop.example", "cream", get))!], [["11", 48], ["12", 90]]);
  assert.equal(await storePrices("shop.example", "cream", async () => ({ status: 404, body: undefined })), undefined);
  assert.equal(await storePrices("shop.example", "../x", get), undefined);
});

test("pricedPack fills a copy from the store and leaves the input pack alone", async () => {
  const { inputDir, productDir } = input(OFFERS);
  const copyDir = path.join(inputDir, "state", "pack", "1");
  const priced = await pricedPack({ productDir, inputDir, copyDir, handle: "cream", productName: "Cream", get: async () => ({ status: 200, body: { variants: [{ id: 11, price: 4800 }] } }) });
  assert.equal(priced.productDir, copyDir);
  const offers = JSON.parse(fs.readFileSync(path.join(copyDir, "offers.json"), "utf8"));
  assert.equal(offers.offers[0].price, 48);
  assert.match(offers.offers[0].price_source, /products\/cream\.js/);
  assert.ok(fs.existsSync(path.join(copyDir, "facts.md")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(productDir, "offers.json"), "utf8")).offers[0].price, null);
});

test("pricedPack falls back to the site screenshots when the store has no product JSON", async () => {
  const { inputDir, productDir } = input(OFFERS);
  const copyDir = path.join(inputDir, "state", "pack", "1");
  const looked: string[][] = [];
  const priced = await pricedPack({
    productDir, inputDir, copyDir, handle: "cream", productName: "Cream",
    get: async () => ({ status: 404, body: undefined }),
    look: async (_product, files) => {
      looked.push(files);
      return { price: 48, file: files[0]! };
    },
  });
  assert.deepEqual(looked, [[path.join(inputDir, "brand", "site", "q1.png")]]);
  assert.equal(priced.source, "the brand's site screenshot brand/site/q1.png");
  assert.equal(JSON.parse(fs.readFileSync(path.join(copyDir, "offers.json"), "utf8")).offers[0].price, 48);
  assert.ok(priced.warnings.some((warning) => warning.includes("no public product JSON")));
});

test("pricedPack leaves a priced pack as it is and says so when nothing grounds a price", async () => {
  const priced = input({ offers: [{ price: 30 }] });
  assert.equal((await pricedPack({ ...priced, copyDir: "/nowhere", handle: "x", productName: "X" })).productDir, priced.productDir);
  const unpriced = input(OFFERS);
  const result = await pricedPack({ ...unpriced, copyDir: path.join(unpriced.inputDir, "copy"), handle: "x", productName: "X", get: async () => ({ status: 404, body: undefined }), look: async () => undefined });
  assert.equal(result.productDir, unpriced.productDir);
  assert.ok(result.warnings.some((warning) => warning.includes("no grounded price")));
});
