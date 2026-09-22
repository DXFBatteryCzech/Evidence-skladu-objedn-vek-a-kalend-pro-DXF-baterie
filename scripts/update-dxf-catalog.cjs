const fs = require("fs");

const BASE = "https://dxf-hobby.store";
const COLLECTIONS = ["ALL ACTIVE PRODUCTS"];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = s => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();

function priceUsd(v) {
  const raw = v?.price;
  if (typeof raw === "string") {
    const n = Number(raw.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(raw || 0);
  if (!Number.isFinite(n)) return 0;
  return Number.isInteger(n) && n >= 1000 ? n / 100 : n;
}

function qtyFrom(text) {
  const s = String(text || "");
  const patterns = [
    /(?:^|[^0-9])(\d+)\s*PCS?\b/i,
    /\b(\d+)\s*[- ]?PACK\b/i,
    /\b(\d+)\s*[x×]\b/i,
    /\b[x×]\s*(\d+)\b/i
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return Math.max(1, Number(m[1]));
  }
  return 1;
}

function parseSpecs(title) {
  const t = String(title || "");
  const cells = Number(t.match(/\b(\d{1,2})\s*S\b/i)?.[1] || 0);
  const capacity = Number(t.match(/\b(\d{3,6})\s*mAh\b/i)?.[1] || 0);
  const cRating = Number(t.match(/\b(\d{2,3})\s*C\b/i)?.[1] || 0);
  const voltage = Number((t.match(/\b(\d{1,2}(?:[.,]\d+)?)\s*V\b/i)?.[1] || "0").replace(",", "."));
  const caseType = /hard\s*case|hardcase/i.test(t) ? "Hardcase" : /soft\s*case|softcase/i.test(t) ? "Softcase" : "Jiné";
  const chemistry = /\bHV\b|LiHV/i.test(t) ? "LiHV" : "LiPo";
  const tags = [];
  for (const tag of ["Graphene","GoldSeries","Golden","Gold","Blue","NGP","LCG","Shorty"]) if (new RegExp("\\b"+tag+"\\b","i").test(t)) tags.push(tag);
  return { cells, capacity, cRating, voltage, caseType, chemistry, series: [...new Set(tags)].join(" ") };
}

function parseDimensions(html) {
  const text = clean(html);
  const m = text.match(/(?:dimension(?:s)?|size)\s*[:：-]?\s*([0-9]+(?:\.[0-9]+)?\s*[x×*]\s*[0-9]+(?:\.[0-9]+)?\s*[x×*]\s*[0-9]+(?:\.[0-9]+)?\s*(?:mm|cm)?)/i);
  return m ? m[1].replace(/\*/g, "×").replace(/\s+/g, " ").trim() : "";
}

function parseWeight(html) {
  const text = clean(html);
  const m = text.match(/(?:net\s*)?weight\s*[:：-]?\s*([0-9]+(?:\.[0-9]+)?)\s*(kg|g)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2].toLowerCase() === "kg" ? Math.round(n * 1000) : Math.round(n);
}

function optionIndex(product, re) {
  const opts = Array.isArray(product?.options) ? product.options : [];
  return opts.findIndex(o => re.test(String(typeof o === "string" ? o : o?.name || "")));
}

function optionValue(v, i) {
  return i < 0 ? "" : String(v?.["option" + (i + 1)] || "");
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "DXF-Catalog-Sync/1.0", "accept": "application/json" } });
  if (!res.ok) throw new Error(url + " -> HTTP " + res.status);
  return res.json();
}

async function fetchAllProducts() {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const url = BASE + "/products.json?limit=250&page=" + page;
    const json = await fetchJson(url);
    const products = Array.isArray(json?.products) ? json.products : [];
    console.log("global products page", page, products.length);
    out.push(...products);
    if (products.length < 250) break;
  }
  return out;
}

async function enrichProduct(p) {
  const handle = p.handle;
  if (!handle) return null;
  const full = p;

  const title = String(p.title || "");
  const specs = parseSpecs(title);
  if (!specs.cells || !specs.capacity || !specs.cRating || specs.caseType === "Jiné") return null;
  if (!/battery|lipo|lihv/i.test(title)) return null;

  const variants = Array.isArray(full.variants) ? full.variants : (Array.isArray(p.variants) ? p.variants : []);
  const warehouseIdx = optionIndex(full, /warehouse|delivery warehouse|sklad/i);
  const connectorIdx = optionIndex(full, /plug|connector|konektor/i);

  let euVariants = warehouseIdx >= 0 ? variants.filter(v => /EUROPE\s*WAREHOUSE/i.test(optionValue(v, warehouseIdx))) : variants;
  let warehouse = warehouseIdx >= 0 ? "EUROPE WAREHOUSE" : "DXF GLOBAL";
  if (!euVariants.length) {
    euVariants = variants;
    warehouse = "DXF GLOBAL";
  }

  const connectors = [...new Set(euVariants.map(v => optionValue(v, connectorIdx)).filter(Boolean).filter(x => !/warehouse/i.test(x)))];

  const variantPrices = euVariants.map(v => {
    const label = [v.title, v.option1, v.option2, v.option3].filter(Boolean).join(" ");
    const qty = qtyFrom(label);
    const totalUsd = priceUsd(v);
    return {
      id: String(v.id || ""),
      title: String(v.title || ""),
      connector: optionValue(v, connectorIdx),
      warehouse,
      qty,
      totalUsd,
      unitUsd: qty ? Number((totalUsd / qty).toFixed(4)) : totalUsd,
      available: v.available !== false
    };
  }).filter(v => v.totalUsd > 0);

  const primaryConnector = connectors[0] || "";
  const primary = variantPrices.filter(v => !primaryConnector || v.connector === primaryConnector);
  const one = primary.find(v => v.qty === 1) || variantPrices.find(v => v.qty === 1) || primary.sort((a,b)=>a.qty-b.qty)[0] || variantPrices.sort((a,b)=>a.qty-b.qty)[0];
  if (!one) return null;

  const tierMap = new Map();
  for (const v of variantPrices.filter(v => !primaryConnector || v.connector === primaryConnector)) {
    if (!tierMap.has(v.qty)) tierMap.set(v.qty, v.totalUsd);
  }
  if (!tierMap.size) for (const v of variantPrices) if (!tierMap.has(v.qty)) tierMap.set(v.qty, v.totalUsd);
  const priceTiers = [...tierMap.entries()].sort((a,b)=>a[0]-b[0]).map(([qty,totalUsd]) => ({ qty, totalUsd }));

  const images = Array.isArray(full.images) ? full.images : (Array.isArray(p.images) ? p.images : []);
  let imageUrl = "";
  const fi = full.featured_image || p.image;
  if (typeof fi === "string") imageUrl = fi.startsWith("//") ? "https:" + fi : fi;
  else if (fi?.src) imageUrl = fi.src;
  if (!imageUrl && images.length) {
    const x = images[0];
    imageUrl = typeof x === "string" ? x : x?.src || "";
  }

  const body = p.body_html || full.description || "";
  const dimensions = parseDimensions(body);
  const weightG = parseWeight(body);

  return {
    id: "live-" + handle,
    sourceHandle: handle,
    sourceTitle: title,
    sourceWarehouse: warehouse,
    sourceDate: new Date().toISOString().slice(0,10),
    productUrl: BASE + "/products/" + handle,
    imageUrl,
    imageData: "",
    isCustom: false,
    customName: "",
    ...specs,
    dimensions,
    weightG,
    packConfig: "",
    supplierPriceUsd: Number((one.totalUsd / Math.max(1, one.qty)).toFixed(2)),
    priceTiers,
    connectors,
    primaryConnector,
    variantPrices,
    descriptionCs: "Aktuální data importovaná z nového DXF webu. Cena a varianty odpovídají " + warehouse + ".",
    sortOrder: 0
  };
}

async function main() {
  const collected = await fetchAllProducts();
  console.log("all active products", collected.length);

  const byHandle = new Map();
  for (const p of collected) if (p?.handle) byHandle.set(p.handle, p);

  const products = [];
  let i = 0;
  for (const p of byHandle.values()) {
    i++;
    try {
      const item = await enrichProduct(p);
      if (item) products.push(item);
    } catch (e) {
      console.warn("Skipping", p.handle, e.message);
    }
    if (i % 20 === 0) await sleep(250);
  }

  const dupCounts = new Map();
  for (const p of products) {
    const k = [p.cells,p.capacity,p.cRating,p.caseType].join("|");
    dupCounts.set(k,(dupCounts.get(k)||0)+1);
  }
  for (const p of products) {
    const k = [p.cells,p.capacity,p.cRating,p.caseType].join("|");
    const base = "DXF baterie " + p.cells + "S " + p.capacity + "mAh " + p.cRating + "C " + p.caseType;
    p.customName = dupCounts.get(k) > 1 && p.series ? base + " " + p.series : base;
  }

  products.sort((a,b) => a.cells-b.cells || a.caseType.localeCompare(b.caseType) || a.capacity-b.capacity || a.cRating-b.cRating || a.customName.localeCompare(b.customName));
  products.forEach((p,i)=>p.sortOrder=i+1);

  const missingUrl = products.filter(p => !p.productUrl);
  const missingImage = products.filter(p => !p.imageUrl);
  const missingPrice = products.filter(p => !(Number(p.supplierPriceUsd) > 0));
  if (missingUrl.length || missingImage.length || missingPrice.length) {
    throw new Error(
      "Kontrola kvality katalogu selhala: URL " + missingUrl.length +
      ", fotografie " + missingImage.length +
      ", cena " + missingPrice.length
    );
  }

  const sample3s7500 = products.find(p =>
    p.cells === 3 && p.capacity === 7500 && p.cRating === 150 &&
    p.caseType === "Hardcase" && /HV/i.test(p.sourceTitle || "")
  );
  if (!sample3s7500) {
    throw new Error("Kontrolní produkt 3S 7500mAh 150C Hardcase HV nebyl nalezen.");
  }
  if (Math.abs(Number(sample3s7500.voltage) - 11.4) > 0.01 || !sample3s7500.productUrl || !sample3s7500.imageUrl) {
    throw new Error("Kontrolní produkt 3S 7500mAh 150C nemá kompletní aktuální data.");
  }
  if (Math.abs(Number(sample3s7500.supplierPriceUsd) - 63) > 0.02) {
    throw new Error("Kontrola ceny 3S 7500mAh 150C selhala: " + sample3s7500.supplierPriceUsd + " USD místo 63.00 USD");
  }

  const known = products.find(p => p.sourceHandle === "dxf-2s-shorty-lipo-battery-7-4v-140c-5200mah-5mm-t-plug-hardcase-1-6-pack-options-available");
  if (!known) {
    throw new Error("Kontrolní produkt 2S Shorty 5200mAh 140C nebyl v aktuálním DXF katalogu nalezen.");
  }
  if (known.sourceWarehouse !== "EUROPE WAREHOUSE") {
    throw new Error("Kontrolní produkt 2S Shorty 5200mAh 140C nemá zvolený EUROPE WAREHOUSE: " + known.sourceWarehouse);
  }
  if (Math.abs(Number(known.supplierPriceUsd) - 51.04) > 0.02) {
    throw new Error("Kontrola Europe Warehouse selhala u 2S 5200 140C: " + known.supplierPriceUsd + " USD místo 51.04 USD");
  }

  const out = {
    schemaVersion: 23,
    generatedAt: new Date().toISOString(),
    source: BASE,
    collections: COLLECTIONS,
    productCount: products.length,
    products
  };
  fs.writeFileSync("dxf-catalog.json", JSON.stringify(out, null, 2) + "\n");
  console.log("Generated", products.length, "current DXF battery products");
}

main().catch(e => { console.error(e); process.exit(1); });
