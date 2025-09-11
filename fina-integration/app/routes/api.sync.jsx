
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { refreshFinaToken } from "../services/fina-auth.js";

/**
 * ===== High-level changes =====
 * - Caches Shopify locationId once per action (no per-variant query)
 * - Batches Shopify variant lookups by SKU using OR query (preloads per internal chunk)
 * - Controls concurrency for per-product work with a lightweight pool (no sleeps)
 * - Batches price updates per product via productVariantsBulkUpdate
 * - Preserves original visibility (usr_column_503=B2C, usr_column_504=B2B) logic
 * - Keeps the external chunking (offset/limit) contract unchanged
 */

// ---------------- FINA helpers ----------------

async function getAllFinaProducts(finaToken) {
  const response = await fetch(`http://178.134.149.81:8082/api/operation/getProducts`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${finaToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) throw new Error(`Failed to get FINA products: ${response.status}`);
  const data = await response.json();
  console.log(`📦 Retrieved ${data.products?.length || 0} products from FINA`);
  return data;
}

async function getFinaProductQuantities(storeId, finaToken) {
  const response = await fetch(`http://178.134.149.81:8082/api/operation/getProductsRestByStore/${storeId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${finaToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) throw new Error(`Failed to get FINA product quantities: ${response.status}`);
  return await response.json();
}

async function getFinaProductPrices(finaToken) {
  const response = await fetch(`http://178.134.149.81:8082/api/operation/getProductPrices`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${finaToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) throw new Error(`Failed to get FINA product prices: ${response.status}`);
  const data = await response.json();
  console.log(`💰 Retrieved prices for ${data.prices?.length || 0} product price entries`);
  return data;
}

// ---------------- Shopify helpers ----------------

/** Cache the primary location ID for the whole action */
let _locationIdCache = null;
async function getPrimaryLocationId(admin) {
  if (_locationIdCache) return _locationIdCache;
  const q = `query { locations(first: 1) { edges { node { id } } } }`;
  const resp = await admin.graphql(q);
  const data = await resp.json();
  const id = data?.data?.locations?.edges?.[0]?.node?.id;
  if (!id) throw new Error('No Shopify location found');
  _locationIdCache = id;
  return id;
}

/** Batch fetch variants by many SKUs using OR query; returns Map<sku, Variant[]> */
async function getShopifyVariantsBySkusBatch(admin, skus) {
  if (!skus || skus.length === 0) return new Map();
  const query = `
    query getVariantsBySkus($q: String!) {
      productVariants(first: 250, query: $q) {
        edges {
          node {
            id
            sku
            price
            inventoryQuantity
            inventoryItem { id }
            product { id title }
          }
        }
      }
    }
  `;
  // Ensure exact match by quoting SKUs; join with OR
  const q = skus.map(s => `sku:${JSON.stringify(s)}`).join(' OR ');
  const resp = await admin.graphql(query, { variables: { q } });
  const data = await resp.json();
  const edges = data?.data?.productVariants?.edges || [];
  const map = new Map();
  for (const e of edges) {
    const node = e.node;
    if (!node?.sku) continue;
    if (!map.has(node.sku)) map.set(node.sku, []);
    map.get(node.sku).push(node);
  }
  return map;
}

/** For large lists, split into batches (default 50 SKUs per OR-query) */
async function preloadChunkVariants(admin, products, batchSize = 50) {
  const result = new Map();
  for (let i = 0; i < products.length; i += batchSize) {
    const part = products.slice(i, i + batchSize).map(p => p.code).filter(Boolean);
    const map = await getShopifyVariantsBySkusBatch(admin, part);
    for (const [sku, variants] of map.entries()) result.set(sku, variants);
  }
  return result;
}

/** Inventory update using cached location id */
async function updateShopifyInventory(inventoryItemId, quantity, admin, locationId) {
  const mutation = `
    mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup { id reason createdAt }
        userErrors { field message code }
      }
    }
  `;
  const variables = {
    input: {
      name: "available",
      reason: "correction",
      quantities: [{ inventoryItemId, locationId, quantity: parseInt(quantity) }],
      ignoreCompareQuantity: true
    }
  };
  const response = await admin.graphql(mutation, { variables });
  return await response.json();
}

/** Batch price updates per product */
async function updateProductVariantPricesBulk(admin, productId, variantsPayload) {
  if (!variantsPayload?.length) return { ok: true };
  const mutation = `
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id price sku updatedAt }
        userErrors { field message }
      }
    }
  `;
  const variables = { productId, variants: variantsPayload };
  const resp = await admin.graphql(mutation, { variables });
  return await resp.json();
}

// ---------------- Utility: small concurrency pool ----------------

async function withConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        results[i] = { error: e?.message || String(e) };
      }
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, run);
  await Promise.all(runners);
  return results;
}

// ---------------- Domain helpers ----------------

function getProductVisibility(product) {
  const visibility = { b2c: '1', b2b: '1' };
  if (product.add_fields && Array.isArray(product.add_fields)) {
    for (const field of product.add_fields) {
      if (field.field === 'usr_column_503') visibility.b2c = field.value || '';
      else if (field.field === 'usr_column_504') visibility.b2b = field.value || '';
    }
  }
  return visibility;
}

// ---------------- Core per-internal-chunk processor (refactored) ----------------

async function processProductChunk(products, quantityMap, b2cPriceMap, b2bPriceMap, admin, chunkIndex, totalChunks) {
  console.log(`🔄 Processing chunk ${chunkIndex + 1}/${totalChunks} (${products.length} products)`);

  // Preload Shopify variants for this internal chunk
  const variantsBySku = await preloadChunkVariants(admin, products, 50);
  const locationId = await getPrimaryLocationId(admin);

  const CONCURRENCY = 30; // tune 20–40 if needed
  const results = await withConcurrency(products, CONCURRENCY, async (product, i) => {
    const productIndex = chunkIndex * 250 + i + 1;
    try {
      const visibility = getProductVisibility(product);
      const isB2CVisible = (visibility.b2c === '1');
      const isB2BVisible = (visibility.b2b === '1');

      const finaQuantity = (isB2CVisible || isB2BVisible) ? Math.floor(quantityMap[product.id] || 0) : 0;
      const finaB2cPrice = isB2CVisible ? parseFloat(b2cPriceMap[product.id] ?? 0) : 0;
      const finaB2bPrice = isB2BVisible ? parseFloat(b2bPriceMap[product.id] ?? 0) : 0;

      const shopifyVariants = variantsBySku.get(product.code) || [];
      if (shopifyVariants.length === 0) {
        return {
          sku: product.code,
          status: 'not_found',
          finaQuantity, finaB2cPrice, finaB2bPrice,
          shopifyQuantity: 'N/A',
          shopifyPrice: 'N/A',
          message: 'Product not found in Shopify'
        };
      }

      let variantUpdated = 0;
      let variantNoChange = 0;
      let variantErrors = 0;
      let allVariantQuantitiesMatch = true;
      let allVariantPricesMatch = true;
      let firstVariantQuantity = null;
      let firstVariantPrice = null;

      const priceUpdates = [];

      for (let vIndex = 0; vIndex < shopifyVariants.length; vIndex++) {
        const variant = shopifyVariants[vIndex];
        const shopifyQuantity = variant.inventoryQuantity || 0;
        const shopifyPrice = parseFloat(variant.price || 0);

        const isB2C = (vIndex === 0);
        const isB2B = (vIndex === 1);

        let targetQuantity = shopifyQuantity;
        let targetPrice = shopifyPrice;
        let hasPriceData = false;

        if (isB2C) {
          targetQuantity = isB2CVisible ? finaQuantity : 0;
          targetPrice = finaB2cPrice;
          hasPriceData = true;
        } else if (isB2B) {
          targetQuantity = isB2BVisible ? finaQuantity : 0;
          targetPrice = finaB2bPrice;
          hasPriceData = true;
        }

        if (firstVariantQuantity === null) firstVariantQuantity = shopifyQuantity;
        if (firstVariantPrice === null) firstVariantPrice = shopifyPrice;

        if (shopifyQuantity !== targetQuantity) allVariantQuantitiesMatch = false;
        if (hasPriceData && Math.abs(shopifyPrice - targetPrice) > 0.01) allVariantPricesMatch = false;

        const quantityMatches = (targetQuantity === shopifyQuantity);
        const priceMatches = hasPriceData ? (Math.abs(shopifyPrice - targetPrice) <= 0.01) : true;

        if (quantityMatches && priceMatches) {
          variantNoChange++;
          continue;
        }

        // Update quantity immediately if needed
        if (!quantityMatches) {
          try {
            const invRes = await updateShopifyInventory(variant.inventoryItem.id, targetQuantity, admin, locationId);
            const invErrs = invRes?.data?.inventorySetQuantities?.userErrors || [];
            if (invErrs.length) {
              console.error('Inventory errors', invErrs);
              variantErrors++;
            } else {
              variantUpdated++;
            }
          } catch (e) {
            console.error('Inventory exception', e);
            variantErrors++;
          }
        }

        // Defer price updates to a single bulk mutation per product
        if (!priceMatches && hasPriceData) {
          priceUpdates.push({ id: variant.id, price: targetPrice.toFixed(2) });
        }
      }

      // One bulk price update per product
      if (priceUpdates.length) {
        try {
          const res = await updateProductVariantPricesBulk(admin, shopifyVariants[0].product.id, priceUpdates);
          const userErrors = res?.data?.productVariantsBulkUpdate?.userErrors || [];
          if (res.errors || userErrors.length) {
            console.error('Price bulk update errors', res.errors || userErrors);
            variantErrors++;
          } else {
            variantUpdated += priceUpdates.length;
          }
        } catch (e) {
          console.error('Price bulk update exception', e);
          variantErrors++;
        }
      }

      if (allVariantQuantitiesMatch && allVariantPricesMatch) {
        return {
          sku: product.code,
          status: 'no_change',
          finaQuantity, finaB2cPrice, finaB2bPrice,
          shopifyQuantity: firstVariantQuantity,
          shopifyPrice: firstVariantPrice,
          variantCount: shopifyVariants.length,
          message: `All ${shopifyVariants.length} variant(s) already match (qty & price)`
        };
      } else if (variantErrors === 0) {
        return {
          sku: product.code,
          status: 'updated',
          finaQuantity, finaB2cPrice, finaB2bPrice,
          shopifyQuantity: `${variantUpdated} updated, ${variantNoChange} unchanged`,
          shopifyPrice: `Updated B2C/B2B prices from FINA`,
          variantCount: shopifyVariants.length,
          message: `Updated ${variantUpdated} of ${shopifyVariants.length} variant(s) (qty/price)`
        };
      } else {
        return {
          sku: product.code,
          status: 'error',
          finaQuantity, finaB2cPrice, finaB2bPrice,
          shopifyQuantity: `${variantUpdated} updated, ${variantErrors} errors`,
          shopifyPrice: `Error updating B2C/B2B prices`,
          variantCount: shopifyVariants.length,
          message: `${variantErrors} error(s) updating ${shopifyVariants.length} variant(s) (qty/price)`
        };
      }
    } catch (err) {
      return {
        sku: product.code,
        status: 'error',
        finaQuantity: quantityMap[product.id] || 0,
        finaB2cPrice: b2cPriceMap[product.id] || 0,
        finaB2bPrice: b2bPriceMap[product.id] || 0,
        shopifyQuantity: 'Error',
        shopifyPrice: 'Error',
        message: err.message
      };
    }
  });

  console.log(`✅ Chunk ${chunkIndex + 1}/${totalChunks} completed`);
  return results;
}

// ---------------- Remix action (unchanged external contract, uses refactored processor) ----------------

export const action = async ({ request }) => {
  const startTime = Date.now();
  console.log(`🚀 ===== SYNC CHUNK STARTED: ${new Date().toISOString()} =====`);

  try {
    const { admin, session } = await authenticate.admin(request);
    console.log(`🏪 Shop: ${session.shop}`);

    const formData = await request.formData();
    const rawOffset = formData.get('offset') || '0';
    const rawLimit = formData.get('limit') || '1500';
    const offset = parseInt(rawOffset);
    const limit = parseInt(rawLimit);

    if (isNaN(offset) || offset < 0) {
      return json({ success: false, isComplete: true, error: "Invalid offset parameter" });
    }
    if (isNaN(limit) || limit <= 0) {
      return json({ success: false, isComplete: true, error: "Invalid limit parameter" });
    }

    const finaToken = await refreshFinaToken();
    const finaProductsData = await getAllFinaProducts(finaToken);
    const allFinaProducts = finaProductsData.products || [];
    const totalProducts = allFinaProducts.length;

    if (totalProducts === 0) {
      return json({ success: true, isComplete: true, message: "No products in FINA", totalProducts: 0 });
    }

    const totalChunks = Math.ceil(totalProducts / limit);
    const currentChunk = Math.floor(offset / limit) + 1;
    const isLastChunk = (offset + limit) >= totalProducts;

    const chunkProducts = allFinaProducts.slice(offset, offset + limit);
    const actualChunkSize = chunkProducts.length;

    // FINA quantities & prices
    const finaQuantitiesData = await getFinaProductQuantities(1, finaToken);
    const finaQuantities = finaQuantitiesData.store_rest || [];
    const quantityMap = {};
    for (const item of finaQuantities) quantityMap[item.id] = item.rest;

    const finaPricesData = await getFinaProductPrices(finaToken);
    const finaPrices = finaPricesData.prices || [];
    const b2cPriceMap = {};
    const b2bPriceMap = {};
    for (const p of finaPrices) {
      const pid = p.product_id;
      const priceId = p.price_id;
      const price = parseFloat(p.price || 0);
      if (priceId === 3) b2cPriceMap[pid] = price;
      else if (priceId === 5) b2bPriceMap[pid] = price;
    }

    // Internal chunking (kept at 250 to align with earlier logic / logs)
    const INTERNAL_CHUNK_SIZE = 250;
    const internalChunks = Math.ceil(chunkProducts.length / INTERNAL_CHUNK_SIZE);
    let chunkResults = [];

    for (let internalIndex = 0; internalIndex < internalChunks; internalIndex++) {
      const startIdx = internalIndex * INTERNAL_CHUNK_SIZE;
      const endIdx = Math.min(startIdx + INTERNAL_CHUNK_SIZE, chunkProducts.length);
      const internalChunk = chunkProducts.slice(startIdx, endIdx);
      const internalResults = await processProductChunk(
        internalChunk,
        quantityMap,
        b2cPriceMap,
        b2bPriceMap,
        admin,
        internalIndex,
        internalChunks
      );
      chunkResults = chunkResults.concat(internalResults);
      // Optional: a short pause between internal chunks if you see rate limits
      // await new Promise(r => setTimeout(r, 250));
    }

    const successful = chunkResults.filter(r => r.status === 'updated').length;
    const noChange = chunkResults.filter(r => r.status === 'no_change').length;
    const errors = chunkResults.filter(r => r.status === 'error').length;
    const notFound = chunkResults.filter(r => r.status === 'not_found').length;

    const processingTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
    const processedProducts = offset + actualChunkSize;
    const isComplete = isLastChunk || processedProducts >= totalProducts;

    return json({
      success: true,
      isComplete,
      message: isComplete
        ? `Sync completed: All ${totalProducts} products processed`
        : `Chunk ${currentChunk}/${totalChunks} completed: ${successful} updated, ${noChange} unchanged, ${errors} errors, ${notFound} not found`,
      totalProducts,
      processedProducts,
      currentChunk,
      totalChunks,
      chunkResults: { successful, noChange, errors, notFound, processed: actualChunkSize },
      nextOffset: isComplete ? null : offset + limit,
      processingTime,
      results: chunkResults.slice(0, 50)
    });

  } catch (error) {
    const processingTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
    console.error(`💥 Sync failed after ${processingTime}:`, error);
    return json({
      success: false,
      isComplete: true,
      error: "Chunk sync failed",
      details: error.message,
      message: `Chunk sync failed after ${processingTime}: ${error.message}`,
      processingTime,
      nextOffset: null
    }, { status: 500 });
  }
};

export default function SyncApiRoute() { return null; }
