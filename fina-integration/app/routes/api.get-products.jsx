import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  try {
    // Authenticate the admin request
    const { admin } = await authenticate.admin(request);
    
    // GraphQL query to fetch first 5 products with detailed information
    const query = `
      query {
        products(first: 5) {
          edges {
            node {
              id
              title
              handle
              descriptionHtml
              productType
              vendor
              tags
              createdAt
              updatedAt
              status
              images(first: 5) {
                edges {
                  node {
                    url
                    altText
                  }
                }
              }
              variants(first: 5) {
                edges {
                  node {
                    id
                    title
                    price
                    sku
                    inventoryQuantity
                    availableForSale
                  }
                }
              }
            }
          }
        }
      }
    `;
    
    // Call Shopify Admin GraphQL API
    const response = await admin.graphql(query);
    const responseJson = await response.json();
    
    // Check for GraphQL errors
    if (responseJson.errors) {
      return json({ 
        error: "GraphQL errors occurred", 
        details: responseJson.errors 
      }, { status: 400 });
    }
    
    // Return the products data
    return json(responseJson.data);
    
  } catch (error) {
    console.error("Error fetching Shopify products:", error);
    return json({ 
      error: "Failed to fetch products from Shopify" 
    }, { status: 500 });
  }
};

// Export a default component to prevent route errors (even though it won't be rendered)
export default function GetProductsApiRoute() {
  return null;
}