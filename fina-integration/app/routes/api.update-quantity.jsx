import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  try {
    // Authenticate the admin request
    const { admin } = await authenticate.admin(request);
    
    // Parse the form data
    const formData = await request.formData();
    const sku = formData.get("sku");
    const quantity = parseInt(formData.get("quantity"));
    const mode = formData.get("mode"); // "add" or "subtract"
    
    // Validate inputs
    if (!sku) {
      return json({ 
        error: "Product SKU is required. Please enter a valid SKU." 
      }, { status: 400 });
    }
    
    if (!quantity) {
      return json({ 
        error: "Quantity is required. Please enter a valid quantity." 
      }, { status: 400 });
    }
    
    if (!mode) {
      return json({ 
        error: "Operation mode is required. Please select Add or Subtract." 
      }, { status: 400 });
    }
    
    if (isNaN(quantity) || quantity <= 0) {
      return json({ 
        error: `Invalid quantity "${quantity}". Please enter a positive number greater than 0.` 
      }, { status: 400 });
    }
    
    // GraphQL query to find product variant by SKU
    const findVariantQuery = `
      query GetVariantBySKU($sku: String!) {
        productVariants(first: 1, query: $sku) {
          nodes {
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
    `;
    
    // Search for the variant (try different search formats)
    let findResponse = await admin.graphql(findVariantQuery, {
      variables: {
        sku: `sku:${sku}`,
      },
    });
    
    let findResponseJson = await findResponse.json();
    
    // If no results with sku: prefix, try without prefix
    if (!findResponseJson.errors && findResponseJson.data.productVariants.nodes.length === 0) {
      console.log(`No results with "sku:${sku}", trying just "${sku}"`);
      findResponse = await admin.graphql(findVariantQuery, {
        variables: {
          sku: sku,
        },
      });
      findResponseJson = await findResponse.json();
    }
    
    // Debug logging
    console.log(`Searching for SKU: ${sku}`);
    console.log("GraphQL response:", JSON.stringify(findResponseJson, null, 2));
    
    if (findResponseJson.errors) {
      console.error("GraphQL errors while searching for product:", findResponseJson.errors);
      return json({ 
        error: `Failed to search for product with SKU "${sku}". Please check if the SKU is correct and try again.`,
        details: findResponseJson.errors.map(err => err.message).join(", ")
      }, { status: 400 });
    }
    
    const variants = findResponseJson.data.productVariants.nodes;
    
    if (variants.length === 0) {
      console.log(`No variants found for SKU: ${sku}`);
      return json({ 
        error: `❌ Product not found: No product variant exists with SKU "${sku}". Please verify the SKU and try again.` 
      }, { status: 404 });
    }
    
    const variant = variants[0];
    const currentQuantity = variant.inventoryQuantity || 0;
    
    // Check if inventory tracking is enabled
    if (!variant.inventoryItem || !variant.inventoryItem.id) {
      return json({ 
        error: `❌ Inventory tracking is not enabled for product SKU "${sku}". Please enable inventory tracking in Shopify admin first.`,
        hint: "Go to Products > [Product Name] > Inventory section and enable 'Track quantity'"
      }, { status: 400 });
    }
    
    // Get the first location (primary location) for inventory updates
    const locationsQuery = `
      query GetLocations {
        locations(first: 1) {
          nodes {
            id
            name
          }
        }
      }
    `;
    
    const locationsResponse = await admin.graphql(locationsQuery);
    const locationsResponseJson = await locationsResponse.json();
    
    if (locationsResponseJson.errors) {
      console.error("GraphQL errors while getting locations:", locationsResponseJson.errors);
      return json({ 
        error: `❌ Failed to get store locations. Cannot update inventory.`,
        details: locationsResponseJson.errors.map(err => err.message).join(", ")
      }, { status: 400 });
    }
    
    const locations = locationsResponseJson.data.locations.nodes;
    
    if (locations.length === 0) {
      return json({ 
        error: `❌ No store locations found. Please set up at least one location in your Shopify admin.`,
        hint: "Go to Settings > Locations to add a location"
      }, { status: 400 });
    }
    
    const locationId = locations[0].id;
    console.log(`Using location: ${locations[0].name} (${locationId})`);
    
    // Calculate expected new quantity
    let expectedQuantity;
    if (mode === "add") {
      expectedQuantity = currentQuantity + quantity;
    } else if (mode === "subtract") {
      expectedQuantity = Math.max(0, currentQuantity - quantity); // Don't go below 0
    } else {
      return json({ 
        error: `❌ Invalid operation mode "${mode}". Please select either "Add to inventory" or "Subtract from inventory".` 
      }, { status: 400 });
    }
    
    // GraphQL mutation to update inventory
    const updateInventoryMutation = `
      mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
        inventoryAdjustQuantities(input: $input) {
          inventoryAdjustmentGroup {
            createdAt
            reason
            changes {
              name
              delta
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;
    
    // Update the inventory
    const inventoryInput = {
      reason: "correction",
      name: "available",
      changes: [
        {
          delta: mode === "add" ? quantity : -quantity,
          inventoryItemId: variant.inventoryItem.id,
          locationId: locationId,
        }
      ]
    };
    
    console.log(`Updating inventory with input:`, inventoryInput);
    
    const updateResponse = await admin.graphql(updateInventoryMutation, {
      variables: {
        input: inventoryInput,
      },
    });
    
    const updateResponseJson = await updateResponse.json();
    console.log("Inventory update response:", JSON.stringify(updateResponseJson, null, 2));
    
    if (updateResponseJson.errors) {
      console.error("GraphQL errors while updating inventory:", updateResponseJson.errors);
      return json({ 
        error: `❌ Failed to update inventory for SKU "${sku}". There was a system error.`,
        details: updateResponseJson.errors.map(err => err.message).join(", ")
      }, { status: 400 });
    }
    
    if (updateResponseJson.data.inventoryAdjustQuantities.userErrors.length > 0) {
      const userErrors = updateResponseJson.data.inventoryAdjustQuantities.userErrors;
      console.error("User errors while updating inventory:", userErrors);
      return json({ 
        error: `❌ Cannot update inventory for SKU "${sku}": ${userErrors.map(err => err.message).join(", ")}`,
        details: userErrors
      }, { status: 400 });
    }
    
    const adjustmentGroup = updateResponseJson.data.inventoryAdjustQuantities.inventoryAdjustmentGroup;
    const deltaApplied = adjustmentGroup.changes[0].delta;
    
    // Calculate new quantity (we need to fetch it or calculate it)
    const newQuantity = currentQuantity + deltaApplied;
    
    return json({
      success: true,
      message: `Successfully ${mode === "add" ? "added" : "subtracted"} ${quantity} units for SKU: ${sku}`,
      product: variant.product.title,
      sku: variant.sku,
      previousQuantity: currentQuantity,
      newQuantity: newQuantity,
      operation: mode,
      quantityChanged: Math.abs(deltaApplied),
      location: locations[0].name
    });
    
  } catch (error) {
    console.error("Unexpected error updating product quantity:", error);
    return json({ 
      error: `❌ Unexpected error occurred while updating product quantity. Please try again or contact support if the problem persists.`,
      details: error.message,
      hint: "Check that the SKU exists in your Shopify store and that inventory tracking is enabled for this product."
    }, { status: 500 });
  }
};

// Export a default component to prevent route errors (even though it won't be rendered)
export default function UpdateQuantityApiRoute() {
  return null;
}