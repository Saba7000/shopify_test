
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * No behavioral change; small hardening on error handling and response shape.
 */
export const action = async ({ request }) => {
  try {
    const { admin } = await authenticate.admin(request);
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
                edges { node { url altText } }
              }
              variants(first: 5) {
                edges { node { id title price sku inventoryQuantity availableForSale } }
              }
            }
          }
        }
      }
    `;
    const response = await admin.graphql(query);
    const responseJson = await response.json();
    if (responseJson.errors) {
      return json({ error: "GraphQL errors occurred", details: responseJson.errors }, { status: 400 });
    }
    return json(responseJson.data);
  } catch (error) {
    console.error("Error fetching Shopify products:", error);
    return json({ error: "Failed to fetch products from Shopify", details: String(error?.message || error) }, { status: 500 });
  }
};

export default function GetProductsApiRoute() { return null; }
