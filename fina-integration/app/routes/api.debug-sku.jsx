import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { refreshFinaToken } from "../services/fina-auth.js";

// Helper function to get ALL products from FINA
async function getAllFinaProducts(finaToken) {
  console.log('🔍 [DEBUG] Fetching all FINA products...');
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
  console.log(`🔍 [DEBUG] Retrieved ${data.products?.length || 0} products from FINA`);
  return data;
}

// Helper function to get FINA product quantities by store
async function getFinaProductQuantities(storeId, finaToken) {
  console.log(`🔍 [DEBUG] Fetching FINA quantities for store ${storeId}...`);
  const response = await fetch(`http://178.134.149.81:8082/api/operation/getProductsRestByStore/${storeId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${finaToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get FINA quantities: ${response.status}`);
  }

  const data = await response.json();
  console.log(`🔍 [DEBUG] Retrieved quantities for ${data.store_rest?.length || 0} products`);
  return data;
}

// Helper function to get ALL Shopify variants by SKU
async function getShopifyVariantsBySku(sku, admin) {
  console.log(`🔍 [DEBUG] Searching Shopify for all variants with SKU: ${sku}`);
  const query = `
    query getProductVariants($query: String!) {
      productVariants(first: 250, query: $query) {
        edges {
          node {
            id
            sku
            inventoryQuantity
            inventoryItem {
              id
            }
            product {
              title
            }
          }
        }
      }
    }
  `;

  const variables = { query: `sku:${sku}` };
  const response = await admin.graphql(query, { variables });
  const data = await response.json();
  
  const variants = data.data?.productVariants?.edges?.map(edge => edge.node) || [];
  console.log(`✅ [DEBUG] Found ${variants.length} Shopify variant(s) with SKU ${sku}`);
  
  variants.forEach((variant, index) => {
    console.log(`  [${index + 1}] ${variant.product.title} - Qty: ${variant.inventoryQuantity}`);
  });
  
  return variants;
}

// Helper function to update Shopify inventory
async function updateShopifyInventory(inventoryItemId, quantity, admin) {
  console.log(`🔍 [DEBUG] Getting primary location...`);
  const locationQuery = `
    query {
      locations(first: 1) {
        edges {
          node {
            id
            name
            isActive
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

  console.log(`🔍 [DEBUG] Using location: ${locationId}`);

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

  console.log(`🔍 [DEBUG] Updating inventory: ${inventoryItemId} → ${quantity}`);
  const response = await admin.graphql(mutation, { variables });
  const result = await response.json();
  
  if (result.data?.inventorySetQuantities?.userErrors?.length > 0) {
    console.error(`❌ [DEBUG] Update failed:`, result.data.inventorySetQuantities.userErrors);
  } else {
    console.log(`✅ [DEBUG] Inventory updated successfully`);
  }
  
  return result;
}

export const action = async ({ request }) => {
  const startTime = Date.now();
  console.log(`\n🔍 ===== SKU DEBUG STARTED: ${new Date().toISOString()} =====`);
  
  try {
    const { admin, session } = await authenticate.admin(request);
    const formData = await request.formData();
    const targetSku = formData.get("sku")?.trim();
    
    if (!targetSku) {
      return json({ 
        success: false, 
        error: "SKU is required",
        message: "Please provide a SKU to debug"
      }, { status: 400 });
    }
    
    console.log(`🔍 [DEBUG] Target SKU: ${targetSku}`);
    console.log(`🏪 [DEBUG] Shop: ${session.shop}`);
    
    // Step 1: Get FINA token
    console.log("🔐 [DEBUG] Getting FINA authentication token...");
    const finaToken = await refreshFinaToken();
    console.log("✅ [DEBUG] FINA token retrieved successfully");
    
    // Step 2: Get ALL FINA products to find the target SKU
    console.log("📦 [DEBUG] Fetching FINA products...");
    const finaProductsData = await getAllFinaProducts(finaToken);
    const finaProducts = finaProductsData.products || [];
    
    // Find the specific product by SKU (code)
    const targetProduct = finaProducts.find(product => product.code === targetSku);
    
    if (!targetProduct) {
      console.log(`❌ [DEBUG] SKU ${targetSku} not found in FINA`);
      return json({ 
        success: false,
        error: "SKU not found in FINA",
        message: `SKU "${targetSku}" was not found in FINA products`,
        finaProductCount: finaProducts.length,
        processingTime: `${((Date.now() - startTime) / 1000).toFixed(1)}s`
      });
    }
    
    console.log(`✅ [DEBUG] Found FINA product: ${targetProduct.name} (ID: ${targetProduct.id})`);
    
    // Step 3: Get FINA quantity for this specific product
    console.log("📊 [DEBUG] Fetching FINA quantities...");
    const finaQuantitiesData = await getFinaProductQuantities(1, finaToken); // Store ID = 1
    const finaQuantities = finaQuantitiesData.store_rest || [];
    
    const quantityInfo = finaQuantities.find(item => item.id === targetProduct.id);
    const finaQuantity = Math.floor(quantityInfo ? quantityInfo.rest : 0);
    
    console.log(`📊 [DEBUG] FINA quantity for ${targetSku}: ${finaQuantity}`);
    
    // Step 4: Check Shopify variants (could be multiple)
    const shopifyVariants = await getShopifyVariantsBySku(targetSku, admin);
    
    if (shopifyVariants.length === 0) {
      console.log(`❌ [DEBUG] SKU ${targetSku} not found in Shopify`);
      return json({ 
        success: false,
        error: "SKU not found in Shopify",
        message: `SKU "${targetSku}" was not found in Shopify`,
        finaProduct: {
          id: targetProduct.id,
          name: targetProduct.name,
          code: targetProduct.code,
          quantity: finaQuantity
        },
        processingTime: `${((Date.now() - startTime) / 1000).toFixed(1)}s`
      });
    }
    
    console.log(`📊 [DEBUG] Processing ${shopifyVariants.length} variant(s) for SKU ${targetSku}`);
    
    // Step 5: Compare and potentially update ALL variants
    let allUpdateResults = [];
    let totalUpdated = 0;
    let totalErrors = 0;
    let totalNoChange = 0;
    
    for (let i = 0; i < shopifyVariants.length; i++) {
      const variant = shopifyVariants[i];
      const shopifyQuantity = variant.inventoryQuantity || 0;
      const needsUpdate = finaQuantity !== shopifyQuantity;
      
      console.log(`📊 [DEBUG] Variant ${i + 1}/${shopifyVariants.length}: ${variant.product.title} - ${shopifyQuantity} → ${finaQuantity}`);
      
      if (needsUpdate) {
        console.log(`🔄 [DEBUG] Updating variant ${i + 1}: ${shopifyQuantity} → ${finaQuantity}`);
        
        try {
          const updateResult = await updateShopifyInventory(
            variant.inventoryItem.id,
            finaQuantity,
            admin
          );
          
          const hasErrors = updateResult.data?.inventorySetQuantities?.userErrors?.length > 0;
          
          if (hasErrors) {
            console.error(`❌ [DEBUG] Variant ${i + 1} update failed:`, updateResult.data.inventorySetQuantities.userErrors);
            allUpdateResults.push({
              variant: i + 1,
              productTitle: variant.product.title,
              status: 'error',
              oldQuantity: shopifyQuantity,
              newQuantity: finaQuantity,
              errors: updateResult.data.inventorySetQuantities.userErrors
            });
            totalErrors++;
          } else {
            console.log(`✅ [DEBUG] Variant ${i + 1} updated successfully`);
            allUpdateResults.push({
              variant: i + 1,
              productTitle: variant.product.title,
              status: 'updated',
              oldQuantity: shopifyQuantity,
              newQuantity: finaQuantity
            });
            totalUpdated++;
          }
          
        } catch (updateError) {
          console.error(`❌ [DEBUG] Variant ${i + 1} update error:`, updateError);
          allUpdateResults.push({
            variant: i + 1,
            productTitle: variant.product.title,
            status: 'error',
            oldQuantity: shopifyQuantity,
            newQuantity: finaQuantity,
            error: updateError.message
          });
          totalErrors++;
        }
      } else {
        console.log(`✅ [DEBUG] Variant ${i + 1} quantities already match - no update needed`);
        allUpdateResults.push({
          variant: i + 1,
          productTitle: variant.product.title,
          status: 'no_change',
          quantity: shopifyQuantity
        });
        totalNoChange++;
      }
    }
    
    const processingTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
    
    console.log(`🎯 [DEBUG] ===== DEBUG COMPLETED =====`);
    console.log(`⏱️ [DEBUG] Processing time: ${processingTime}`);
    console.log(`📦 [DEBUG] FINA Product: ${targetProduct.name}`);
    console.log(`📊 [DEBUG] FINA Qty: ${finaQuantity}`);
    console.log(`🔄 [DEBUG] Variants processed: ${shopifyVariants.length}`);
    console.log(`✅ [DEBUG] Updated: ${totalUpdated}, No change: ${totalNoChange}, Errors: ${totalErrors}`);
    console.log(`🔍 ===== DEBUG ENDED: ${new Date().toISOString()} =====\n`);
    
    const hasAnyUpdates = totalUpdated > 0;
    const hasAnyErrors = totalErrors > 0;
    
    let message = `${targetSku}: `;
    if (shopifyVariants.length === 1) {
      if (totalUpdated > 0) {
        message += `Updated 1 variant (${allUpdateResults[0].oldQuantity} → ${finaQuantity})`;
      } else if (totalNoChange > 0) {
        message += `Quantity already matches (${finaQuantity})`;
      } else {
        message += `Failed to update variant`;
      }
    } else {
      message += `${totalUpdated} updated, ${totalNoChange} no change, ${totalErrors} errors (${shopifyVariants.length} variants total)`;
    }
    
    return json({ 
      success: totalErrors === 0, // Success if no errors occurred
      message,
      data: {
        sku: targetSku,
        finaProduct: {
          id: targetProduct.id,
          name: targetProduct.name,
          code: targetProduct.code,
          quantity: finaQuantity
        },
        shopifyVariants: shopifyVariants.map(variant => ({
          id: variant.id,
          sku: variant.sku,
          quantity: variant.inventoryQuantity,
          productTitle: variant.product.title,
          inventoryItemId: variant.inventoryItem.id
        })),
        variantCount: shopifyVariants.length,
        totalUpdated,
        totalNoChange,
        totalErrors,
        updateResults: allUpdateResults,
        processingTime
      }
    });
    
  } catch (error) {
    const processingTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
    console.error(`\n💥 [DEBUG] ===== DEBUG FAILED =====`);
    console.error(`⏱️ [DEBUG] Failed after: ${processingTime}`);
    console.error(`❌ [DEBUG] Error:`, error);
    console.error(`📍 [DEBUG] Stack:`, error.stack);
    console.error(`💥 [DEBUG] ===== DEBUG FAILED END =====\n`);
    
    return json({ 
      success: false,
      error: "Debug failed",
      details: error.message,
      message: `Debug failed after ${processingTime}: ${error.message}`,
      processingTime
    }, { status: 500 });
  }
};

// Export a default component to prevent route errors
export default function DebugSkuApiRoute() {
  return null;
}
