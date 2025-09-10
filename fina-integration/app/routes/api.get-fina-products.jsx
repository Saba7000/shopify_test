import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { refreshFinaToken } from "../services/fina-auth.js";

export const action = async ({ request }) => {
  // Authenticate the request
  await authenticate.admin(request);
  
  try {
    // Always get fresh FINA token (for Vercel reliability)
    const finaToken = await refreshFinaToken();
    
    // Make request to FINA Products API
    const response = await fetch("http://178.134.149.81:8082/api/operation/getProducts", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${finaToken}`,
        "Content-Type": "application/json",
      },
    });
    
    if (!response.ok) {
      return json({ 
        error: `FINA Products API returned ${response.status}: ${response.statusText}` 
      }, { status: response.status });
    }
    
    const finaProductsData = await response.json();
    return json(finaProductsData);
    
  } catch (error) {
    console.error("Error calling FINA Products API:", error);
    return json({ 
      error: "Failed to connect to FINA Products API" 
    }, { status: 500 });
  }
};

// Export a default component to prevent route errors (even though it won't be rendered)
export default function GetFinaProductsApiRoute() {
  return null;
}