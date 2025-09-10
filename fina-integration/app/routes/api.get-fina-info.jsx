import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { refreshFinaToken } from "../services/fina-auth.js";

export const action = async ({ request }) => {
  // Authenticate the request
  await authenticate.admin(request);
  
  try {
    // Always get fresh FINA token (for Vercel reliability)
    const finaToken = await refreshFinaToken();
    
    // Make request to FINA API
    const response = await fetch("http://178.134.149.81:8082/api/info/getapiinfo", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${finaToken}`,
        "Content-Type": "application/json",
      },
    });
    
    if (!response.ok) {
      return json({ 
        error: `FINA API returned ${response.status}: ${response.statusText}` 
      }, { status: response.status });
    }
    
    const finaData = await response.json();
    return json(finaData);
    
  } catch (error) {
    console.error("Error calling FINA API:", error);
    return json({ 
      error: "Failed to connect to FINA API" 
    }, { status: 500 });
  }
};

// Export a default component to prevent route errors (even though it won't be rendered)
export default function GetFinaInfoApiRoute() {
  return null;
}