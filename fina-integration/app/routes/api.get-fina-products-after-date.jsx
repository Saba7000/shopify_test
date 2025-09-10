import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { refreshFinaToken } from "../services/fina-auth.js";

export const action = async ({ request }) => {
  // Authenticate the request
  await authenticate.admin(request);
  
  try {
    // Always get fresh FINA token (for Vercel reliability)
    const finaToken = await refreshFinaToken();
    
    // Get form data
    const formData = await request.formData();
    const afterDate = formData.get("afterDate");
    
    if (!afterDate) {
      return json({ 
        error: "After date is required. Please provide a date in yyyy-MM-ddTHH:mm:ss format." 
      }, { status: 400 });
    }
    
    // Validate date format (basic validation)
    const dateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
    if (!dateRegex.test(afterDate)) {
      return json({ 
        error: "Invalid date format. Please use yyyy-MM-ddTHH:mm:ss format (e.g., 2024-01-15T10:30:00)" 
      }, { status: 400 });
    }
    
    // Construct URL with date parameter
    const url = `http://178.134.149.81:8082/api/operation/getProductsAfter/${afterDate}`;
    
    // Make request to FINA Products After Date API
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${finaToken}`,
        "Content-Type": "application/json",
      },
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      return json({ 
        error: `FINA Products After Date API returned ${response.status}: ${response.statusText}`,
        details: errorText
      }, { status: response.status });
    }
    
    const finaProductsData = await response.json();
    return json({ 
      ...finaProductsData, 
      afterDate: afterDate // Include the date parameter in response for UI display
    });
    
  } catch (error) {
    console.error("Error calling FINA Products After Date API:", error);
    return json({ 
      error: "Failed to connect to FINA Products After Date API",
      details: error.message
    }, { status: 500 });
  }
};

// Export a default component to prevent route errors (even though it won't be rendered)
export default function GetFinaProductsAfterDateApiRoute() {
  return null;
}