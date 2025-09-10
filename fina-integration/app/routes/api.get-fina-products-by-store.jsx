import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { refreshFinaToken } from "../services/fina-auth.js";

export const action = async ({ request }) => {
  // Authenticate the request
  await authenticate.admin(request);
  
  try {
    // Parse the form data to get store ID
    const formData = await request.formData();
    const storeId = formData.get("storeId");
    
    // Validate store ID
    if (!storeId) {
      return json({ 
        error: "Store ID is required. Please enter a store ID." 
      }, { status: 400 });
    }
    
    // Always get fresh FINA token (for Vercel reliability)
    const finaToken = await refreshFinaToken();
    
    // Make request to FINA Products by Store API
    const apiUrl = `http://178.134.149.81:8082/api/operation/getProductsRestByStore/${storeId}`;
    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${finaToken}`,
        "Content-Type": "application/json",
      },
    });
    
    if (!response.ok) {
      return json({ 
        error: `FINA Products by Store API returned ${response.status}: ${response.statusText} for Store ID: ${storeId}` 
      }, { status: response.status });
    }
    
    const finaProductsData = await response.json();
    return json({
      ...finaProductsData,
      storeId: storeId // Include the store ID in the response for reference
    });
    
  } catch (error) {
    console.error("Error calling FINA Products by Store API:", error);
    return json({ 
      error: "Failed to connect to FINA Products by Store API" 
    }, { status: 500 });
  }
};

// Export a default component to prevent route errors (even though it won't be rendered)
export default function GetFinaProductsByStoreApiRoute() {
  return null;
}