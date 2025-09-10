import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { refreshFinaToken } from "../services/fina-auth.js";

// Helper function to get ALL products from FINA
async function getAllFinaProducts(finaToken) {
  console.log('📦 Fetching all FINA products...');
  const response = await fetch(`http://178.134.149.81:8082/api/operation/getProducts`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${finaToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get FINA products: ${response.status}`);
  }

  const data = await response.json();
  console.log(`📦 Retrieved ${data.products?.length || 0} products from FINA`);
  return data;
}

// Helper function to get FINA product quantities by store
async function getFinaProductQuantities(storeId, finaToken) {
  const response = await fetch(`http://178.134.149.81:8082/api/operation/getProductsRestByStore/${storeId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${finaToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get FINA product quantities: ${response.status}`);
  }

  return await response.json();
}

// Helper function to get FINA product prices
async function getFinaProductPrices(finaToken) {
  console.log('💰 Fetching FINA product prices...');
  const response = await fetch(`http://178.134.149.81:8082/api/operation/getProductPrices`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${finaToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get FINA product prices: ${response.status}`);
  }

  const data = await response.json();
  console.log(`💰 Retrieved prices for ${data.prices?.length || 0} product price entries`);
  return data;
}

// Helper function to get ALL Shopify variants by SKU
async function getShopifyVariantsBySku(sku, admin) {
  const query = `
    query getVariantsBySku($query: String!) {
      productVariants(first: 250, query: $query) {
        edges {
          node {
            id
            sku
            price
            inventoryQuantity
            inventoryItem {
              id
            }
            product {
              id
              title
            }
          }
        }
      }
    }
  `;

  const response = await admin.graphql(query, {
    variables: { query: `sku:${sku}` }
  });

  const data = await response.json();
  const variants = data.data?.productVariants?.edges?.map(edge => edge.node) || [];
  return variants;
}

// Helper function to update Shopify inventory
async function updateShopifyInventory(inventoryItemId, quantity, admin) {
  // First get the location ID (using the first available location)
  const locationQuery = `
    query {
      locations(first: 1) {
        edges {
          node {
            id
          }
        }
      }
    }
  `;

  const locationResponse = await admin.graphql(locationQuery);
  const locationData = await locationResponse.json();
  const locationId = locationData.data?.locations?.edges?.[0]?.node?.id;

  if (!locationId) {
    throw new Error('No location found');
  }

  const mutation = `
    mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup {
          id
          reason
          createdAt
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const variables = {
    input: {
      name: "available",
      reason: "correction",
      quantities: [
        {
          inventoryItemId,
          locationId,
          quantity: parseInt(quantity)
        }
      ],
      ignoreCompareQuantity: true
    }
  };

  const response = await admin.graphql(mutation, { variables });
  return await response.json();
}

// Helper function to update Shopify variant price using productVariantsBulkUpdate (2025-01)
async function updateShopifyVariantPrice(variantId, productId, price, admin) {
  const mutation = `
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          price
          sku
          updatedAt
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    productId: productId,
    variants: [
      {
        id: variantId,
        price: price.toFixed(2) // Price as string, currency from shop
      }
    ]
  };

  console.log(`💰 PRICE UPDATE - Variant: ${variantId}, Product: ${productId}, Price: ${price.toFixed(2)}`);
  console.log(`💰 PRICE UPDATE - Variables:`, JSON.stringify(variables, null, 2));

  const response = await admin.graphql(mutation, { variables });
  const result = await response.json();
  
  console.log(`💰 PRICE UPDATE - GraphQL Response:`, JSON.stringify(result, null, 2));
  
  return result;
}


// Helper function to process a chunk of products
// Helper function to get visibility values from FINA product add_fields
function getProductVisibility(product) {
  const visibility = {
    b2c: '1', // default to visible
    b2b: '1'  // default to visible
  };
  
  if (product.add_fields && Array.isArray(product.add_fields)) {
    product.add_fields.forEach(field => {
      if (field.field === 'usr_column_503') { // B2C visibility
        visibility.b2c = field.value || '';
      } else if (field.field === 'usr_column_504') { // B2B visibility
        visibility.b2b = field.value || '';
      }
    });
  }
  
  console.log(`👁️ Product ${product.code} visibility - B2C: "${visibility.b2c}", B2B: "${visibility.b2b}"`);
  return visibility;
}

async function processProductChunk(products, quantityMap, b2cPriceMap, b2bPriceMap, admin, chunkIndex, totalChunks) {
  console.log(`🔄 Processing chunk ${chunkIndex + 1}/${totalChunks} (${products.length} products)`);
  const chunkResults = [];
  
  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    const productIndex = chunkIndex * 250 + i + 1; // Global product index
    
    try {
      console.log(`🔍 [${productIndex}] Processing: ${product.code} (ID: ${product.id})`);
      
      // 👁️ CHECK VISIBILITY FIRST: Extract visibility for B2C and B2B variants
      const visibility = getProductVisibility(product);
      
      // 🚀 PERFORMANCE: Only get FINA data for visible variants
      let finaQuantity = 0;
      let finaB2cPrice = 0;
      let finaB2bPrice = 0;
      
      // B2C Visibility Check (usr_column_503)
      const isB2CVisible = (visibility.b2c === '1');
      const isB2BVisible = (visibility.b2b === '1');
      
      if (isB2CVisible) {
        // B2C is visible - get quantity and B2C price from FINA
        finaQuantity = Math.floor(quantityMap[product.id] || 0);
        finaB2cPrice = parseFloat(b2cPriceMap[product.id] ?? 0);
        console.log(`✅ [${productIndex}] B2C visible - Qty: ${finaQuantity}, B2C Price: ${finaB2cPrice}`);
      } else {
        // B2C is hidden - force quantity=0, price=0 
        finaQuantity = 0;
        finaB2cPrice = 0;
        console.log(`🚫 [${productIndex}] B2C hidden (usr_column_503="${visibility.b2c}") - Qty: 0, B2C Price: 0`);
      }
      
      if (isB2BVisible) {
        // B2B is visible - get B2B price from FINA (quantity already set above)
        finaB2bPrice = parseFloat(b2bPriceMap[product.id] ?? 0);
        console.log(`✅ [${productIndex}] B2B visible - B2B Price: ${finaB2bPrice}`);
      } else {
        // B2B is hidden - force price=0
        finaB2bPrice = 0;
        console.log(`🚫 [${productIndex}] B2B hidden (usr_column_504="${visibility.b2b}") - B2B Price: 0`);
      }
      
      console.log(`💰 [${productIndex}] Final values for ${product.code}: Qty=${finaQuantity}, B2C=${finaB2cPrice}, B2B=${finaB2bPrice}`);
      
      // Get ALL Shopify variants by SKU (could be multiple)
      const shopifyVariants = await getShopifyVariantsBySku(product.code, admin);
      
      if (shopifyVariants.length === 0) {
        console.log(`⚠️ [${productIndex}] Product ${product.code} not found in Shopify`);
        chunkResults.push({
          sku: product.code,
          status: 'not_found',
          finaQuantity,
          finaB2cPrice,
          finaB2bPrice,
          shopifyQuantity: 'N/A',
          shopifyPrice: 'N/A',
          message: 'Product not found in Shopify'
        });
        continue;
      }
      
      console.log(`🔍 [${productIndex}] ${product.code}: Found ${shopifyVariants.length} variant(s)`);
      
      // Process ALL variants for this SKU
      let variantUpdated = 0;
      let variantNoChange = 0;
      let variantErrors = 0;
      let allVariantQuantitiesMatch = true;
      let allVariantPricesMatch = true;
      let firstVariantQuantity = null;
      let firstVariantPrice = null;
      
      for (let vIndex = 0; vIndex < shopifyVariants.length; vIndex++) {
        const variant = shopifyVariants[vIndex];
        const shopifyQuantity = variant.inventoryQuantity || 0;
        const shopifyPrice = parseFloat(variant.price || 0);
        
        // Determine which FINA price to use based on variant position
        // First variant (vIndex 0) = B2C (price_id 3)
        // Second variant (vIndex 1) = B2B (price_id 5)
        const isB2C = (vIndex === 0);
        const isB2B = (vIndex === 1);
        const variantType = isB2C ? 'B2C' : (isB2B ? 'B2B' : `Unknown(${vIndex})`);
        
        // 🎯 USE PRE-CALCULATED VALUES: Visibility already handled above
        let targetQuantity;
        let targetPrice = 0;
        let hasPriceData = false;
        
        // Set quantity and price based on variant type and visibility
        if (isB2C) {
          targetQuantity = isB2CVisible ? finaQuantity : 0; // 0 if hidden, FINA quantity if visible
          targetPrice = finaB2cPrice; // Already 0 if hidden
          hasPriceData = true; // Always update to ensure correct price (including 0)
        } else if (isB2B) {
          targetQuantity = isB2BVisible ? finaQuantity : 0; // 0 if hidden, FINA quantity if visible
          targetPrice = finaB2bPrice; // Already 0 if hidden  
          hasPriceData = true; // Always update to ensure correct price (including 0)
        }
        
        if (firstVariantQuantity === null) {
          firstVariantQuantity = shopifyQuantity;
        }
        if (firstVariantPrice === null) {
          firstVariantPrice = shopifyPrice;
        }
        
        if (shopifyQuantity !== targetQuantity) {
          allVariantQuantitiesMatch = false;
        }
        if (hasPriceData && Math.abs(shopifyPrice - targetPrice) > 0.01) { // Allow 0.01 difference for floating point precision
          allVariantPricesMatch = false;
        }
        
        console.log(`🔍 [${productIndex}.${vIndex + 1}] ${variant.product.title} (${variantType}): Qty ${shopifyQuantity} → ${targetQuantity}, Price ${shopifyPrice} → ${targetPrice} ${hasPriceData ? '✅' : '❌'}`);
        
        // Check if both quantity and price match
        const quantityMatches = (targetQuantity === shopifyQuantity);
        const priceMatches = hasPriceData ? (Math.abs(shopifyPrice - targetPrice) <= 0.01) : true; // Skip price check if no FINA price data
        
        if (quantityMatches && priceMatches) {
          console.log(`✅ [${productIndex}.${vIndex + 1}] Quantity and price already match`);
          variantNoChange++;
        } else {
          console.log(`🔄 [${productIndex}.${vIndex + 1}] Updating variant - Qty: ${!quantityMatches ? 'CHANGE' : 'OK'}, Price: ${!priceMatches ? 'CHANGE' : 'OK'}`);
          
          let quantityUpdateSuccess = true;
          let priceUpdateSuccess = true;
          
          try {
            // Update quantity if needed
            if (!quantityMatches) {
              console.log(`📦 [${productIndex}.${vIndex + 1}] Updating quantity: ${shopifyQuantity} → ${targetQuantity}`);
            const updateResult = await updateShopifyInventory(
              variant.inventoryItem.id,
              targetQuantity,
              admin
            );
            
            if (updateResult.data?.inventorySetQuantities?.userErrors?.length > 0) {
              const errors = updateResult.data.inventorySetQuantities.userErrors;
                console.error(`❌ [${productIndex}.${vIndex + 1}] Failed to update quantity:`, errors);
                quantityUpdateSuccess = false;
              } else {
                console.log(`✅ [${productIndex}.${vIndex + 1}] Successfully updated quantity`);
              }
            }
            
            // Update price if needed
            if (!priceMatches && hasPriceData) { // Only update if FINA has price data for this variant type
              console.log(`💰 [${productIndex}.${vIndex + 1}] Updating ${variantType} price: ${shopifyPrice} → ${targetPrice}`);
              const priceResult = await updateShopifyVariantPrice(
                variant.id,
                variant.product.id,
                targetPrice,
                admin
              );
              
              // Check for errors in the GraphQL response
              if (priceResult.errors) {
                console.error(`❌ [${productIndex}.${vIndex + 1}] GraphQL errors in price update:`, priceResult.errors);
                priceUpdateSuccess = false;
              } else if (priceResult.data?.productVariantsBulkUpdate?.userErrors?.length > 0) {
                const errors = priceResult.data.productVariantsBulkUpdate.userErrors;
                console.error(`❌ [${productIndex}.${vIndex + 1}] Failed to update price:`, errors);
                priceUpdateSuccess = false;
              } else if (!priceResult.data?.productVariantsBulkUpdate?.productVariants?.length) {
                console.error(`❌ [${productIndex}.${vIndex + 1}] Price update failed - no productVariants returned`);
                priceUpdateSuccess = false;
              } else {
                const updatedVariant = priceResult.data.productVariantsBulkUpdate.productVariants[0];
                const newPrice = updatedVariant.price;
                console.log(`✅ [${productIndex}.${vIndex + 1}] Successfully updated price to: ${newPrice}`);
              }
            }
            
            // Count success/failure
            if (quantityUpdateSuccess && priceUpdateSuccess) {
              variantUpdated++;
            } else {
              variantErrors++;
            }
            
          } catch (variantError) {
            console.error(`❌ [${productIndex}.${vIndex + 1}] Variant update error:`, variantError);
            variantErrors++;
          }
        }
      }
      
      // Summarize results for this SKU
      if (allVariantQuantitiesMatch && allVariantPricesMatch) {
        console.log(`✅ [${productIndex}] ${product.code}: All ${shopifyVariants.length} variant(s) match (Qty: ${finaQuantity}, B2C: ${finaB2cPrice}, B2B: ${finaB2bPrice})`);
        chunkResults.push({
          sku: product.code,
          status: 'no_change',
          finaQuantity,
          finaB2cPrice,
          finaB2bPrice,
          shopifyQuantity: firstVariantQuantity,
          shopifyPrice: firstVariantPrice,
          variantCount: shopifyVariants.length,
          message: `All ${shopifyVariants.length} variant(s) already match (qty & price)`
        });
      } else if (variantErrors === 0) {
        console.log(`✅ [${productIndex}] ${product.code}: Updated ${variantUpdated}/${shopifyVariants.length} variant(s) (qty/price)`);
        chunkResults.push({
          sku: product.code,
          status: 'updated',
          finaQuantity,
          finaB2cPrice,
          finaB2bPrice,
          shopifyQuantity: `${variantUpdated} updated, ${variantNoChange} unchanged`,
          shopifyPrice: `Updated B2C/B2B prices from FINA`,
          variantCount: shopifyVariants.length,
          message: `Updated ${variantUpdated} of ${shopifyVariants.length} variant(s) (qty/price)`
        });
      } else {
        console.log(`❌ [${productIndex}] ${product.code}: ${variantErrors} error(s) in ${shopifyVariants.length} variant(s)`);
        chunkResults.push({
          sku: product.code,
          status: 'error',
          finaQuantity,
          finaB2cPrice,
          finaB2bPrice,
          shopifyQuantity: `${variantUpdated} updated, ${variantErrors} errors`,
          shopifyPrice: `Error updating B2C/B2B prices`,
          variantCount: shopifyVariants.length,
          message: `${variantErrors} error(s) updating ${shopifyVariants.length} variant(s) (qty/price)`
        });
      }
      
    } catch (productError) {
      console.error(`❌ [${productIndex}] Error processing ${product.code}:`, productError);
      chunkResults.push({
        sku: product.code,
        status: 'error',
        finaQuantity: quantityMap[product.id] || 0,
        finaB2cPrice: b2cPriceMap[product.id] || 0,
        finaB2bPrice: b2bPriceMap[product.id] || 0,
        shopifyQuantity: 'Error',
        shopifyPrice: 'Error',
        message: productError.message
      });
    }
    
    // Small delay every 10 products to avoid rate limits
    if (i > 0 && i % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  console.log(`✅ Chunk ${chunkIndex + 1}/${totalChunks} completed`);
  return chunkResults;
}

export const action = async ({ request }) => {
  const startTime = Date.now();
  console.log(`🚀 ===== SYNC CHUNK STARTED: ${new Date().toISOString()} =====`);
  
  try {
    // Authenticate the Shopify admin request
    const { admin, session } = await authenticate.admin(request);
    console.log(`🏪 Shop: ${session.shop}`);
    
    // Get chunking parameters from request
    const formData = await request.formData();

    const rawOffset = formData.get('offset') || '0';
    const rawLimit = formData.get('limit') || '1500';
    
    // Parse and validate offset
    const offset = parseInt(rawOffset);
    const limit = parseInt(rawLimit);
    
    console.log(`🔍 RAW FORM DATA: offset="${rawOffset}", limit="${rawLimit}"`);
    console.log(`🔍 PARSED VALUES: offset=${offset}, limit=${limit}`);
    
    // Validate offset is a valid number
    if (isNaN(offset) || offset < 0) {
      console.error(`❌ Invalid offset received: "${rawOffset}" -> ${offset}`);
      return json({ 
        success: false,
        isComplete: true,
        error: "Invalid offset parameter",
        details: `Received offset "${rawOffset}" which parsed to ${offset}. Expected a non-negative integer.`
      });
    }
    
    // Validate limit is a valid number
    if (isNaN(limit) || limit <= 0) {
      console.error(`❌ Invalid limit received: "${rawLimit}" -> ${limit}`);
      return json({ 
        success: false,
        isComplete: true,
        error: "Invalid limit parameter",
        details: `Received limit "${rawLimit}" which parsed to ${limit}. Expected a positive integer.`
      });
    }
    
    console.log(`🔄 Processing chunk: offset=${offset}, limit=${limit}`);
    
    // Step 1: Get FINA token
    console.log("🔐 Getting FINA authentication token...");
    const finaToken = await refreshFinaToken();
    console.log("✅ FINA token retrieved successfully");
    
    // Step 2: Get ALL FINA products (we need total count)
    console.log("📦 Fetching all FINA products...");
    const finaProductsData = await getAllFinaProducts(finaToken);
    const allFinaProducts = finaProductsData.products || [];
    console.log(`📦 Retrieved ${allFinaProducts.length} total products from FINA`);
    
    if (allFinaProducts.length === 0) {
      console.log("⚠️ No products found in FINA");
      return json({ 
        success: true,
        isComplete: true,
        message: "Sync completed - No products found in FINA",
        totalProducts: 0,
        processedProducts: 0,
        chunkResults: {
          successful: 0,
          noChange: 0,
          errors: 0,
          notFound: 0
        },
        overallResults: {
          successful: 0,
          noChange: 0,
          errors: 0,
          notFound: 0
        },
        currentChunk: 1,
        totalChunks: 1,
        processingTime: `${((Date.now() - startTime) / 1000).toFixed(1)}s`
      });
    }
    
    // Step 3: Calculate chunking info
    const totalProducts = allFinaProducts.length;
    const totalChunks = Math.ceil(totalProducts / limit);
    const currentChunk = Math.floor(offset / limit) + 1;
    const isLastChunk = (offset + limit) >= totalProducts;
    
    // Get the products for this chunk
    const chunkProducts = allFinaProducts.slice(offset, offset + limit);
    const actualChunkSize = chunkProducts.length;
    
    console.log(`📊 Chunk ${currentChunk}/${totalChunks}: Processing ${actualChunkSize} products (${offset + 1}-${offset + actualChunkSize} of ${totalProducts})`);
    
    // Debug: Show first and last few product IDs in this chunk
    if (chunkProducts.length > 0) {
      const firstFew = chunkProducts.slice(0, 3).map(p => `${p.product_id}(${p.sku || 'no-sku'})`);
      const lastFew = chunkProducts.length > 3 ? chunkProducts.slice(-3).map(p => `${p.product_id}(${p.sku || 'no-sku'})`) : [];
      console.log(`🔍 CHUNK ${currentChunk} PRODUCTS - First: [${firstFew.join(', ')}]${lastFew.length > 0 ? `, Last: [${lastFew.join(', ')}]` : ''}`);
      console.log(`🔍 CHUNK ${currentChunk} OFFSET DEBUG - offset=${offset}, limit=${limit}, totalProducts=${totalProducts}`);
    }
    
    if (chunkProducts.length === 0) {
      console.log("⚠️ No products in this chunk");
      return json({ 
        success: true,
        isComplete: true,
        message: "Chunk completed - No products in this range",
        totalProducts,
        processedProducts: offset,
        chunkResults: {
          successful: 0,
          noChange: 0,
          errors: 0,
          notFound: 0
        },
        overallResults: {
          successful: 0,
          noChange: 0,
          errors: 0,
          notFound: 0
        },
        currentChunk,
        totalChunks,
        processingTime: `${((Date.now() - startTime) / 1000).toFixed(1)}s`
      });
    }
    
    // Step 4: Get FINA product quantities
    console.log("📊 Fetching FINA product quantities...");
    const finaQuantitiesData = await getFinaProductQuantities(1, finaToken); // Store ID = 1
    const finaQuantities = finaQuantitiesData.store_rest || [];
    console.log(`📊 Retrieved quantities for ${finaQuantities.length} products`);
    
    // Step 4.5: Get FINA product prices
    console.log("💰 Fetching FINA product prices...");
    const finaPricesData = await getFinaProductPrices(finaToken);
    const finaPrices = finaPricesData.prices || [];
    console.log(`💰 Retrieved prices for ${finaPrices.length} product price entries`);
    
    // Create quantity map for quick lookup
    const quantityMap = {};

    finaQuantities.forEach(item => {
      quantityMap[item.id] = item.rest;
    });
    
    // Create separate B2C and B2B price maps based on price_id
    const b2cPriceMap = {}; // price_id: 3
    const b2bPriceMap = {}; // price_id: 5
    console.log(`💰 Sample FINA price entries (first 5):`, finaPrices.slice(0, 5));
    
    finaPrices.forEach(item => {
      const productId = item.product_id;
      const priceId = item.price_id;
      const currentPrice = parseFloat(item.price || 0);
      
      if (priceId === 3) {
        // B2C pricing (first variant)
        b2cPriceMap[productId] = currentPrice;
      } else if (priceId === 5) {
        // B2B pricing (second variant)
        b2bPriceMap[productId] = currentPrice;
      }

      // Note: price_id 4 and any other IDs are intentionally ignored
    });
    
    console.log(`💰 Created B2C price map for ${Object.keys(b2cPriceMap).length} products (price_id: 3)`);
    console.log(`💰 Created B2B price map for ${Object.keys(b2bPriceMap).length} products (price_id: 5)`);
    console.log(`💰 Sample B2C price entries:`, Object.entries(b2cPriceMap).slice(0, 5));
    console.log(`💰 Sample B2B price entries:`, Object.entries(b2bPriceMap).slice(0, 5));
    console.log(`💰 B2C non-zero price count:`, Object.values(b2cPriceMap).filter(price => price > 0).length);
    console.log(`💰 B2B non-zero price count:`, Object.values(b2bPriceMap).filter(price => price > 0).length);
    
    // Step 5: Process THIS chunk of products (using smaller internal chunks for API rate limiting)
    const INTERNAL_CHUNK_SIZE = 250; // Keep internal chunking for API rate limits
    const internalChunks = Math.ceil(chunkProducts.length / INTERNAL_CHUNK_SIZE);
    console.log(`📊 Processing ${chunkProducts.length} products in ${internalChunks} internal chunks of ${INTERNAL_CHUNK_SIZE}`);
    
    let chunkResults = [];
    
    for (let internalIndex = 0; internalIndex < internalChunks; internalIndex++) {
      const startIdx = internalIndex * INTERNAL_CHUNK_SIZE;
      const endIdx = Math.min(startIdx + INTERNAL_CHUNK_SIZE, chunkProducts.length);
      const internalChunk = chunkProducts.slice(startIdx, endIdx);
      
      console.log(`\n🔄 ===== INTERNAL CHUNK ${internalIndex + 1}/${internalChunks} ===== (Products ${startIdx + 1}-${endIdx} of chunk)`);
      
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
      
      // Progress logging within this chunk
      const processed = chunkResults.length;
      const percent = ((processed / chunkProducts.length) * 100).toFixed(1);
      console.log(`📊 Chunk Progress: ${processed}/${chunkProducts.length} (${percent}%)`);
      
      // Small delay between internal chunks to avoid overwhelming APIs
      if (internalIndex < internalChunks - 1) {
        console.log("⏱️ Waiting 1 second before next internal chunk...");
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Step 6: Calculate chunk summary
    const successful = chunkResults.filter(r => r.status === 'updated').length;
    const noChange = chunkResults.filter(r => r.status === 'no_change').length;
    const errors = chunkResults.filter(r => r.status === 'error').length;
    const notFound = chunkResults.filter(r => r.status === 'not_found').length;
    
    const processingTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
    const processedProducts = offset + actualChunkSize;
    
    console.log(`\n🎯 ===== CHUNK ${currentChunk}/${totalChunks} COMPLETED =====`);
    console.log(`⏱️ Processing time: ${processingTime}`);
    console.log(`📦 Chunk products: ${actualChunkSize}`);
    console.log(`📊 Overall progress: ${processedProducts}/${totalProducts} (${((processedProducts/totalProducts)*100).toFixed(1)}%)`);
    console.log(`✅ Updated: ${successful}`);
    console.log(`➖ No change: ${noChange}`);
    console.log(`❌ Errors: ${errors}`);
    console.log(`⚠️ Not found: ${notFound}`);
    console.log(`🚀 ===== CHUNK ENDED: ${new Date().toISOString()} =====\n`);
    
    // Determine if this is the last chunk
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
      chunkResults: {
        successful,
        noChange,
        errors,
        notFound,
        processed: actualChunkSize
      },
      // For frontend to calculate running totals
      nextOffset: isComplete ? null : offset + limit,
      processingTime,
      results: chunkResults.slice(0, 50) // Limit results for response size
    });
    
  } catch (error) {
    const processingTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
    console.error(`\n💥 ===== CHUNK SYNC FAILED =====`);
    console.error(`⏱️ Failed after: ${processingTime}`);
    console.error(`❌ Error:`, error);
    console.error(`📍 Stack:`, error.stack);
    console.error(`💥 ===== CHUNK SYNC FAILED END =====\n`);
    
    return json({ 
      success: false,
      isComplete: true, // Stop the chunking on error
      error: "Chunk sync failed",
      details: error.message,
      message: `Chunk sync failed after ${processingTime}: ${error.message}`,
      processingTime,
      nextOffset: null // No next chunk on error
    }, { status: 500 });
  }
};

    // Export a default component to prevent route errors (even though it won't be rendered)
    export default function SyncApiRoute() {
    return null;
    }