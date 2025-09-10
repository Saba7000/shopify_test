import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { refreshFinaToken } from "../services/fina-auth.js";

export const action = async ({ request }) => {
  // Authenticate the request
  await authenticate.admin(request);
  
  try {
    // Always get fresh FINA token (for Vercel reliability)
    const finaToken = await refreshFinaToken();
    
    // Make request to FINA Customers API
    const response = await fetch("http://178.134.149.81:8082/api/operation/getCustomers", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${finaToken}`,
        "Content-Type": "application/json",
      },
    });
    
    if (!response.ok) {
      return json({ 
        error: `FINA Customers API returned ${response.status}: ${response.statusText}` 
      }, { status: response.status });
    }
    
    const finaCustomersData = await response.json();
    return json(finaCustomersData);
    
  } catch (error) {
    console.error("Error calling FINA Customers API:", error);
    return json({ 
      error: "Failed to connect to FINA Customers API" 
    }, { status: 500 });
  }
};

// Export a default component to prevent route errors (even though it won't be rendered)
export default function GetFinaCustomersApiRoute() {
  return null;
}