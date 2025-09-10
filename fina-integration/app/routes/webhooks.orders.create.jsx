import { authenticate } from "../shopify.server";
import { refreshFinaToken } from "../services/fina-auth.js";

// FINA API configuration
const FINA_API_BASE = "http://178.134.149.81:8082/api/operation";

// Helper function to get ALL FINA products for SKU mapping
async function getAllFinaProducts(finaToken) {
  console.log('📦 Fetching all FINA products for SKU mapping...');
  const response = await fetch(`${FINA_API_BASE}/getProducts`, {
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
  console.log(`📦 Retrieved ${data.products?.length || 0} products from FINA for mapping`);
  return data.products || [];
}

// Helper function to get customer data with metafields from Shopify
async function getShopifyCustomerWithMetafields(customerId, session) {
  try {
    const response = await fetch(`https://${session.shop}/admin/api/2023-10/customers/${customerId}.json`, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': session.accessToken,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch customer: ${response.status}`);
    }

    const customerData = await response.json();
    
    // Get customer metafields
    const metafieldsResponse = await fetch(`https://${session.shop}/admin/api/2023-10/customers/${customerId}/metafields.json`, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': session.accessToken,
        'Content-Type': 'application/json',
      },
    });

    let metafields = [];
    if (metafieldsResponse.ok) {
      const metafieldsData = await metafieldsResponse.json();
      metafields = metafieldsData.metafields || [];
    }

    return {
      customer: customerData.customer,
      metafields: metafields
    };
  } catch (error) {
    console.error('Error fetching customer data:', error);
    throw error;
  }
}

// Helper function to get metafield value by key
function getMetafieldValue(metafields, key) {
  const metafield = metafields.find(m => m.key === key);
  return metafield ? metafield.value : null;
}

// Helper function to check if customer exists in FINA and get customer ID
async function getFinaCustomerByCode(customerCode) {
  try {
    // Get FINA authentication token
    const finaToken = await refreshFinaToken();
    
    // Use correct FINA customer check endpoint
    const response = await fetch(`${FINA_API_BASE}/getCustomersByCode/${customerCode}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${finaToken}`,
        'Content-Type': 'application/json',
      },
    });

    console.log(`🔍 FINA customer check response: ${response.status} for code: ${customerCode}`);
    
    if (!response.ok) {
      console.error(`❌ Failed to check customer in FINA: ${response.status}`);
      return null;
    }

    const data = await response.json();
    console.log(`📋 FINA customer check result:`, data);
    
    // Check if contragents array has any customers and return the customer data
    if (data.contragents && data.contragents.length > 0) {
      const customer = data.contragents[0]; // Get first customer
      console.log(`✅ Customer found in FINA with ID: ${customer.id}`);
      return customer;
    }
    
    console.log(`❌ Customer not found in FINA for code: ${customerCode}`);
    return null;
  } catch (error) {
    console.error('❌ Error checking FINA customer:', error);
    return null;
  }
}

// Helper function to create customer in FINA
async function createFinaCustomer(customerData, metafields) {
  try {
    // Get FINA authentication token
    const finaToken = await refreshFinaToken();
    
    const businessNumber = getMetafieldValue(metafields, 'business_number') || '000000000'; // Fixed: underscore not hyphen
    
    // Get customer address (using first address or default)
    const address = customerData.addresses && customerData.addresses.length > 0 
      ? `${customerData.addresses[0].address1 || ''} ${customerData.addresses[0].city || ''}`.trim()
      : 'Online Store';

    const finaCustomerData = {
      id: 0, // Always 0 for new customers
      code: businessNumber, // business-number metafield value
      name: `${customerData.first_name || ''} ${customerData.last_name || ''}`.trim() || 'Online Store',
      group_id: 5, // Always 5
      address: address, // Customer address
      phone: customerData.phone || '+995555555555', // Customer phone
      email: customerData.email || 'onlinestore@gmail.com', // Customer email
      vat_type: 1, // Always 1 (fixed value)
      is_resident: true, // Always true
      is_company: true, // Always true for business customers
      cons_period: 30, // Always 30
      birth_date: '2001-11-08T18:00:00' // Fixed date
    };

    console.log('🆕 Creating FINA business customer:', finaCustomerData);

    const response = await fetch(`${FINA_API_BASE}/saveCustomer`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${finaToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(finaCustomerData),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ FINA customer creation failed: ${response.status} - ${errorText}`);
      throw new Error(`Failed to create FINA customer: ${response.status}`);
    }

    const result = await response.json();
    console.log('✅ FINA customer created successfully:', result);
    return result;
  } catch (error) {
    console.error('❌ Error creating FINA customer:', error);
    throw error;
  }
}

// Helper function to get order tags from Shopify using GraphQL
async function getShopifyOrderTags(orderId, admin) {
  try {
    console.log(`🔍 Checking tags for Shopify order ${orderId}`);
    
    const query = `
      query getOrder($id: ID!) {
        order(id: $id) {
          id
          tags
        }
      }
    `;
    
    const variables = {
      id: `gid://shopify/Order/${orderId}`
    };
    
    const response = await admin.graphql(query, { variables });
    const data = await response.json();
    
    if (data.errors) {
      console.error(`❌ GraphQL errors getting order tags:`, data.errors);
      throw new Error(`Failed to get order tags: ${data.errors.map(e => e.message).join(', ')}`);
    }

    const tags = data.data?.order?.tags || [];
    console.log(`📋 Order ${orderId} current tags: [${tags.join(', ')}]`);
    return tags;
  } catch (error) {
    console.error(`❌ Error getting order tags:`, error);
    return [];
  }
}

// Helper function to add tags to Shopify order using GraphQL
async function addTagToShopifyOrder(orderId, tag, admin) {
  try {
    console.log(`🏷️ Adding tag "${tag}" to Shopify order ${orderId}`);
    
    const mutation = `
      mutation tagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          node {
            id
          }
          userErrors {
            message
          }
        }
      }
    `;
    
    const variables = {
      id: `gid://shopify/Order/${orderId}`,
      tags: [tag]
    };
    
    const response = await admin.graphql(mutation, { variables });
    const data = await response.json();
    
    if (data.data?.tagsAdd?.userErrors?.length > 0) {
      console.error(`❌ GraphQL errors adding tag:`, data.data.tagsAdd.userErrors);
      throw new Error(`Failed to add tag: ${data.data.tagsAdd.userErrors.map(e => e.message).join(', ')}`);
    }

    console.log(`✅ Successfully added tag "${tag}" to order ${orderId} using GraphQL`);
    return true;
  } catch (error) {
    console.error(`❌ Error adding tag to Shopify order:`, error);
    return false;
  }
}

// Helper function to create order in FINA with actual products
async function createFinaOrder(orderData, finaCustomerId) {
  try {
    console.log('📋 Creating FINA order with products...');
    // Get FINA authentication token
    const finaToken = await refreshFinaToken();
    
    // Step 1: Get all FINA products for SKU mapping
    const finaProducts = await getAllFinaProducts(finaToken);
    
    // Create SKU → FINA ID mapping
    const skuToFinaIdMap = {};
    finaProducts.forEach(product => {
      if (product.code) {
        skuToFinaIdMap[product.code] = product.id;
      }
    });
    
    console.log(`📊 Created SKU mapping for ${Object.keys(skuToFinaIdMap).length} products`);
    
    // Step 2: Process Shopify line items to build products array
    const products = [];
    const lineItems = orderData.line_items || [];
    
    console.log(`📦 Processing ${lineItems.length} line items from Shopify order`);
    
    for (let i = 0; i < lineItems.length; i++) {
      const item = lineItems[i];
      const sku = item.sku;
      const quantity = parseFloat(item.quantity || 0);
      const price = parseFloat(item.price || 0);
      
      console.log(`📦 Item ${i + 1}: SKU="${sku}", Qty=${quantity}, Price=${price}`);
      
      if (!sku) {
        console.log(`⚠️ Item ${i + 1} has no SKU, skipping`);
        continue;
      }
      
      const finaProductId = skuToFinaIdMap[sku];
      
      if (!finaProductId) {
        console.log(`❌ SKU "${sku}" not found in FINA products, skipping`);
        continue;
      }
      
      products.push({
        id: finaProductId,
        sub_id: 0,
        quantity: quantity,
        price: price
      });
      
      console.log(`✅ Added product: FINA ID=${finaProductId}, SKU="${sku}", Qty=${quantity}, Price=${price}`);
    }
    
    console.log(`📦 Successfully mapped ${products.length} products for FINA order`);
    
    // Calculate shipping cost
    const shippingCost = parseFloat(orderData.total_shipping_price_set?.shop_money?.amount || 0);
    console.log(`🚚 Shipping cost: ${shippingCost}`);
    
    // Extract customer name from order
    const customerName = `${orderData.customer?.first_name || ''} ${orderData.customer?.last_name || ''}`.trim() 
      || orderData.billing_address?.name 
      || orderData.shipping_address?.name 
      || 'Online Customer';
    
    // Extract shipping address from order
    const shippingAddress = orderData.shipping_address 
      ? `${orderData.shipping_address.address1 || ''} ${orderData.shipping_address.address2 || ''} ${orderData.shipping_address.city || ''} ${orderData.shipping_address.province || ''} ${orderData.shipping_address.country || ''}`.replace(/\s+/g, ' ').trim()
      : orderData.billing_address 
        ? `${orderData.billing_address.address1 || ''} ${orderData.billing_address.address2 || ''} ${orderData.billing_address.city || ''} ${orderData.billing_address.province || ''} ${orderData.billing_address.country || ''}`.replace(/\s+/g, ' ').trim()
        : 'ონლაინ შეკვეთა';
    
    console.log(`👤 Customer name: ${customerName}`);
    console.log(`📍 Shipping address: ${shippingAddress}`);
    
    // FINA order structure according to specifications
    const finaOrderData = {
      id: 0, // Always 0
      date: orderData.created_at, // Order creation time from Shopify
      num_pfx: "", // Stay empty
      num: parseInt(orderData.id), // Shopify order ID
      purpose: "რეალიზაცია", // Fixed value
      amount: parseFloat(orderData.total_price), // Full order amount
      currency: "GEL", // Fixed
      rate: 1.0, // Fixed
      store: 1, // Fixed for now
      user: 1, // Fixed for now
      staff: 0, // Fixed
      project: 1, // Fixed
      customer: finaCustomerId, // FINA customer ID (not code!)
      is_vat: true, // Fixed
      make_entry: true, // Fixed
      pay_type: 1, // Fixed
      price_type: 3, // Fixed for now
      w_type: 2, // Fixed for now
      t_type: 4, // Fixed
      
      t_payer: 2, // Fixed as 2 per specification
      w_cost: shippingCost, // Shipping cost from order
      foreign: false, // Fixed
      drv_name: "", // Empty per specification
      tr_start: "თბილისი. თემქა. მე-3 მ/რ. მე-2 კვ. 29-ე კორპუსის მიმდებარედ", // New fixed address
      tr_end: shippingAddress, // Customer shipping address from Shopify order
      driver_id: "", // Empty per specification
      car_num: "", // Empty per specification
      tr_text: "", // Empty per specification
      sender: "", // Empty per specification
      reciever: customerName, // Customer name from Shopify order
      comment: "", // Empty per specification
      overlap_type: 0, // Fixed
      overlap_amount: 0, // Fixed
      products: products, // Actual products from Shopify order
      services: shippingCost > 0 ? [{
        id: 6996, // Always 6996 as requested
        quantity: 1.0, // Always 1 as requested
        price: shippingCost // Shipping cost from Shopify order
      }] : [] // Only add service if there's shipping cost
    };

    console.log('📦 Creating FINA order with structure:', finaOrderData);

    const response = await fetch(`${FINA_API_BASE}/saveDocProductOut`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${finaToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(finaOrderData),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ FINA order creation failed: ${response.status} - ${errorText}`);
      throw new Error(`Failed to create FINA order: ${response.status}`);
    }

    const result = await response.json();
    console.log('✅ FINA order created successfully:', result);
    return result;
  } catch (error) {
    console.error('❌ Error creating FINA order:', error);
    throw error;
  }
}

// Main function to process order and handle customer logic
async function processOrderToFina(order, session, admin) {
  try {
    console.log(`🔄 Processing order ${order.id} for FINA integration`);
    
    if (!order.customer || !order.customer.id) {
      console.log('⚠️ Order has no customer, skipping FINA integration');
      return;
    }

    // Step 1: Get customer data with metafields
    console.log(`📝 Fetching customer data for customer ID: ${order.customer.id}`);
    const { customer, metafields } = await getShopifyCustomerWithMetafields(order.customer.id, session);
    
    // 👤 LOG: Full Customer Details
    console.log("=".repeat(60));
    console.log("👤 FULL CUSTOMER DETAILS:");
    console.log("=".repeat(60));
    console.log(JSON.stringify(customer, null, 2));
    console.log("=".repeat(60));
    
    // 🏷️ LOG: Customer Metafields
    console.log("=".repeat(60));
    console.log("🏷️ CUSTOMER METAFIELDS:");
    console.log("=".repeat(60));
    console.log(JSON.stringify(metafields, null, 2));
    console.log("=".repeat(60));
    
    // Step 2: Check business metafield
    const businessMetafield = getMetafieldValue(metafields, 'business');
    const isBusiness = businessMetafield === 'true';
    
    console.log(`👤 Customer: ${customer.first_name} ${customer.last_name}, Business: ${isBusiness}`);
    console.log(`🔍 Business Metafield Value: "${businessMetafield}"`);
    console.log(`🏢 Is Business Customer: ${isBusiness}`);
    
    let finaCustomerId;
    
    if (!isBusiness) {
      // Use existing "Online Store" customer in FINA (ID: 45)
      console.log('🏪 Using default Online Store customer for non-business customer');
      finaCustomerId = 45; // Fixed ID for Online Store customer
    } else {
      // Business customer - check if exists, create if not
      const businessNumber = getMetafieldValue(metafields, 'business_number'); // Fixed: underscore not hyphen
      const vatStatus = getMetafieldValue(metafields, 'vat_status'); // Fixed: underscore not hyphen
      
      // 📊 LOG: Important Metafields for FINA
      console.log("=".repeat(40));
      console.log("📊 METAFIELDS FOR FINA MAPPING:");
      console.log(`🔢 Business Number: "${businessNumber}"`);
      console.log(`🧾 VAT Status: "${vatStatus}"`);
      console.log(`🏢 Business Flag: "${businessMetafield}"`);
      console.log("=".repeat(40));
      
      if (!businessNumber) {
        console.log('⚠️ Business customer has no business_number metafield, skipping');
        return;
      }
      
      console.log(`🏢 Checking if business customer exists in FINA: ${businessNumber}`);
      const existingCustomer = await getFinaCustomerByCode(businessNumber);
      
      if (existingCustomer) {
        console.log(`✅ Business customer already exists in FINA with ID: ${existingCustomer.id}`);
        finaCustomerId = existingCustomer.id; // Use actual FINA customer ID
      } else {
        console.log('📝 Business customer does not exist, creating new customer in FINA');
        const createdCustomer = await createFinaCustomer(customer, metafields);
        // Get the ID from the created customer response
        finaCustomerId = createdCustomer.id || null;
        
        if (!finaCustomerId) {
          console.error('❌ Failed to get customer ID from FINA creation response');
          throw new Error('Unable to get FINA customer ID after creation');
        }
        
        console.log(`✅ New business customer created with FINA ID: ${finaCustomerId}`);
      }
    }
    
    // Step 3: Create order in FINA
    console.log(`📦 Creating order in FINA with customer ID: ${finaCustomerId}`);
    
    try {
      await createFinaOrder(order, finaCustomerId);
      
      // Success - Add success tag to Shopify order
      await addTagToShopifyOrder(order.id, 'successfully order created in fina', admin);
      console.log('✅ Order successfully processed to FINA and tagged in Shopify');
      
    } catch (finaOrderError) {
      // Failed to create order in FINA - Add failure tag to Shopify order
      await addTagToShopifyOrder(order.id, 'order creating problem in fina', admin);
      console.error('❌ Failed to create order in FINA, tagged order accordingly');
      throw finaOrderError;
    }
    
  } catch (error) {
    console.error('❌ Error processing order to FINA:', error);
    // If error occurred before order creation, still try to add failure tag
    try {
      await addTagToShopifyOrder(order.id, 'order creating problem in fina', admin);
    } catch (tagError) {
      console.error('❌ Also failed to tag order:', tagError);
    }
    throw error;
  }
}

// Simple loader to handle GET requests (for browser visits)
export const loader = async () => {
  return new Response("Webhook endpoint is active. Use POST requests only.", { 
    status: 200,
    headers: { "Content-Type": "text/plain" }
  });
};

export const action = async ({ request }) => {
  try {
    const { payload, session, topic, shop, admin } = await authenticate.webhook(request);
    
    console.log("✅ Webhook authentication successful!");
    console.log(`Received ${topic} webhook for shop: ${shop}`);

    try {
      // Process the order data
      const order = payload;
      console.log(`New order created: ${order.id} for ${order.total_price} ${order.currency}`);
      
      // 🔍 DUPLICATE PREVENTION: Check if order was already processed
      console.log(`🔍 Checking if order ${order.id} was already processed...`);
      const existingTags = await getShopifyOrderTags(order.id, admin);
      
      if (existingTags.includes('successfully order created in fina')) {
        console.log(`✅ Order ${order.id} already processed successfully - skipping duplicate processing`);
        return new Response("Order already processed", { status: 200 });
      }
      
      if (existingTags.includes('start processing')) {
        console.log(`⏳ Order ${order.id} is currently being processed by another webhook - skipping duplicate processing`);
        return new Response("Order currently processing", { status: 200 });
      }
      
      if (existingTags.includes('order creating problem in fina')) {
        console.log(`⚠️ Order ${order.id} previously failed - retrying processing`);
      }
      
      console.log(`🆕 Order ${order.id} not yet processed - proceeding with Fina integration`);
      
      // 🏷️ CLAIM ORDER: Add "start processing" tag immediately to prevent duplicates
      console.log(`🏷️ Claiming order ${order.id} for processing...`);
      await addTagToShopifyOrder(order.id, 'start processing', admin);
      console.log(`✅ Order ${order.id} claimed successfully - continuing with processing`);
      
      // 📋 LOG: Full Order Details
      console.log("=".repeat(60));
      console.log("📦 FULL ORDER DETAILS:");
      console.log("=".repeat(60));
      console.log(JSON.stringify(order, null, 2));
      console.log("=".repeat(60));
      
      // Process order to FINA
      await processOrderToFina(order, session, admin);
      
      console.log("✅ Order webhook processed successfully");
      return new Response("OK", { status: 200 });
    } catch (processingError) {
      console.error("❌ Error processing order data:", processingError);
      console.error("🚫 Will not retry due to processing error - webhook acknowledged");
      // Try to add error tag before returning
      try {
        await addTagToShopifyOrder(order.id, 'order creating problem in fina', admin);
      } catch (tagError) {
        console.error('❌ Also failed to update tag after processing error:', tagError);
      }
      // Return 200 to prevent Shopify from retrying the webhook
      return new Response("Processing Error - No Retry", { status: 200 });
    }
  } catch (authError) {
    console.error("❌ Webhook authentication failed");
    console.error("This might be a retry of an old failed webhook");
    
    return new Response(
      JSON.stringify({
        error: "Webhook authentication failed",
        timestamp: new Date().toISOString()
      }), 
      { 
        status: 401,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }
};
