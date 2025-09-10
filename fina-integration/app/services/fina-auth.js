/**
 * Fina Authentication Service
 * Handles token generation and management for Fina API
 */

let cachedToken = null;
let tokenExpiry = null;

/**
 * Authenticate with Fina API and get access token
 * Token is valid for 36 hours
 */
export async function getFinaToken() {
  // Check if we have a valid cached token
  if (cachedToken && tokenExpiry && new Date() < tokenExpiry) {
    console.log("Using cached Fina token");
    return cachedToken;
  }

  // Get credentials from environment
  const finaLogin = process.env.FINA_LOGIN;
  const finaPassword = process.env.FINA_PASSWORD;
  const finaBaseUrl = "http://178.134.149.81:8082"; // Fina API base URL

  if (!finaLogin || !finaPassword) {
    throw new Error("FINA_LOGIN and FINA_PASSWORD must be set in environment variables");
  }

  try {
    console.log("Generating new Fina token...");
    
    // Make authentication request to Fina
    const response = await fetch(`${finaBaseUrl}/api/authentication/authenticate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        login: finaLogin,
        password: finaPassword,
      }),
    });

    if (!response.ok) {
      throw new Error(`Fina authentication failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    if (!data.token) {
      throw new Error("No token received from Fina API");
    }

    // Cache the token (valid for 36 hours)
    cachedToken = data.token;
    tokenExpiry = new Date(Date.now() + 36 * 60 * 60 * 1000); // 36 hours from now
    
    console.log(`Fina token generated successfully. Expires at: ${tokenExpiry.toISOString()}`);
    
    return cachedToken;
    
  } catch (error) {
    console.error("Error getting Fina token:", error);
    throw new Error(`Failed to authenticate with Fina: ${error.message}`);
  }
}

/**
 * Force refresh of Fina token (useful for SYNC button)
 */
export async function refreshFinaToken() {
  console.log("Forcing Fina token refresh...");
  cachedToken = null;
  tokenExpiry = null;
  return await getFinaToken();
}

/**
 * Get current token status
 */
export function getTokenStatus() {
  return {
    hasToken: !!cachedToken,
    isValid: cachedToken && tokenExpiry && new Date() < tokenExpiry,
    expiresAt: tokenExpiry?.toISOString(),
    timeUntilExpiry: tokenExpiry ? Math.max(0, tokenExpiry.getTime() - Date.now()) : 0
  };
}