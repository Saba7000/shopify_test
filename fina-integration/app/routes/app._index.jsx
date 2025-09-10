import { useState, useEffect, useRef } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Page,
  Text,
  Card,
  Button,
  BlockStack,
  Box,
  InlineStack,
  TextField,
  Select,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return null;
};



export default function Index() {
  const syncFetcher = useFetcher();
  const finaFetcher = useFetcher();
  const finaProductsFetcher = useFetcher();
  const finaCustomersFetcher = useFetcher();
  const finaProductsByStoreFetcher = useFetcher();
  const finaProductsAfterDateFetcher = useFetcher();
  const productsFetcher = useFetcher();
  const quantityFetcher = useFetcher();
  const shopify = useAppBridge();
  
  // Form state for quantity update
  const [sku, setSku] = useState("");
  const [quantity, setQuantity] = useState("");
  const [mode, setMode] = useState("add");
  
  // Form state for Fina API inputs
  const [afterDate, setAfterDate] = useState("");
  const [storeId, setStoreId] = useState("");
  
  // State to track cumulative sync results across all chunks
  const [cumulativeResults, setCumulativeResults] = useState({
    updated: 0,
    noChange: 0,
    errors: 0,
    notFound: 0
  });
  
  // Track processed chunks to prevent double-counting
  const processedChunks = useRef(new Set());
  const handleSync = (offset = 0) => {
    // Ensure offset is a valid number
    const validOffset = typeof offset === 'number' && !isNaN(offset) ? offset : 0;
    console.log(`🚀 Frontend: Starting sync with offset=${validOffset} (original: ${offset}, type: ${typeof offset})`);
    
    // Reset cumulative results when starting a new sync (offset = 0)
    if (validOffset === 0) {
      setCumulativeResults({
        updated: 0,
        noChange: 0,
        errors: 0,
        notFound: 0
      });
      processedChunks.current.clear();
    }
    
    const formData = new FormData();
    formData.append("offset", validOffset.toString());
    syncFetcher.submit(formData, { method: "POST", action: "/api/sync" });
  };

  // Auto-continue with next chunk when current chunk completes
  useEffect(() => {
    if (syncFetcher.data && syncFetcher.state === "idle") {
      const currentOffset = syncFetcher.data.processedProducts - (syncFetcher.data.chunkResults?.processed || 0);
      const chunkKey = `${currentOffset}-${syncFetcher.data.processedProducts}`;
      
      // Accumulate results only if we haven't processed this chunk yet
      if (syncFetcher.data.chunkResults && !processedChunks.current.has(chunkKey)) {
        const chunkData = syncFetcher.data.chunkResults;
        setCumulativeResults(prev => ({
          updated: prev.updated + (chunkData.successful || 0),
          noChange: prev.noChange + (chunkData.noChange || 0),
          errors: prev.errors + (chunkData.errors || 0),
          notFound: prev.notFound + (chunkData.notFound || 0)
        }));
        processedChunks.current.add(chunkKey);
      }
      
      // Check if there's a next chunk to process
      if (!syncFetcher.data.isComplete && syncFetcher.data.nextOffset !== null) {
        console.log(`🔄 Auto-continuing with next chunk at offset: ${syncFetcher.data.nextOffset}`);
        setTimeout(() => {
          handleSync(syncFetcher.data.nextOffset);
        }, 1000); // 1 second delay between chunks
      } else if (syncFetcher.data.isComplete) {
        console.log(`✅ Sync completed! All chunks processed.`);
        // Use cumulative results for the toast 
        setTimeout(() => {
          const statsMessage = `✅ Sync Complete: ${cumulativeResults.updated} updated, ${cumulativeResults.noChange} unchanged, ${cumulativeResults.errors} errors, ${cumulativeResults.notFound} not found`;
          shopify.toast.show(statsMessage, { isError: false, duration: 10000 });
        }, 100); // Small delay to ensure state is updated
      }
    }
  }, [syncFetcher.data, syncFetcher.state, shopify, cumulativeResults]);

  const handleGetFinaInfo = () => finaFetcher.submit({}, { method: "POST", action: "/api/get-fina-info" });
  const handleGetFinaProducts = () => finaProductsFetcher.submit({}, { method: "POST", action: "/api/get-fina-products" });
  const handleGetFinaCustomers = () => finaCustomersFetcher.submit({}, { method: "POST", action: "/api/get-fina-customers" });
  const handleGetFinaProductsByStore = () => {
    if (!storeId.trim()) {
      shopify.toast.show("❌ Please enter a Store ID", { isError: true });
      return;
    }
    const formData = new FormData();
    formData.append("storeId", storeId.trim());
    finaProductsByStoreFetcher.submit(formData, { method: "POST", action: "/api/get-fina-products-by-store" });
  };
  
  const handleGetFinaProductsAfterDate = () => {
    if (!afterDate.trim()) {
      shopify.toast.show("❌ Please enter a date", { isError: true });
      return;
    }
    const formData = new FormData();
    formData.append("afterDate", afterDate.trim());
    finaProductsAfterDateFetcher.submit(formData, { method: "POST", action: "/api/get-fina-products-after-date" });
  };
  const handleGetProducts = () => productsFetcher.submit({}, { method: "POST", action: "/api/get-products" });
  
  const handleUpdateQuantity = () => {
    // Clear previous results
    if (quantityFetcher.data) {
      // Reset by creating a new fetcher instance or just continue (data will be replaced)
    }
    
    // Client-side validation
    if (!sku.trim()) {
      shopify.toast.show("❌ Please enter a product SKU", { isError: true });
      return;
    }
    
    if (!quantity.trim()) {
      shopify.toast.show("❌ Please enter a quantity", { isError: true });
      return;
    }
    
    const numQuantity = parseInt(quantity);
    if (isNaN(numQuantity) || numQuantity <= 0) {
      shopify.toast.show(`❌ Invalid quantity "${quantity}". Please enter a positive number.`, { isError: true });
      return;
    }
    
    const formData = new FormData();
    formData.append("sku", sku.trim());
    formData.append("quantity", quantity.trim());
    formData.append("mode", mode);
    
    quantityFetcher.submit(formData, { method: "POST", action: "/api/update-quantity" });
  };

  return (
    <Page>
      <TitleBar title="Fina Integration Dashboard" />
      <BlockStack gap="500">
        {/* Sync Button - Standalone */}
        <Card>
          <BlockStack gap="300">
            <Button 
              variant="primary" 
              onClick={() => handleSync()}
              loading={syncFetcher.state === "submitting"}
            >
              Sync
            </Button>
            {syncFetcher.data && (
              <Box
                padding="300"
                background={syncFetcher.data.isComplete ? "bg-surface-success" : "bg-surface-highlight"}
                borderWidth="025"
                borderRadius="200"
                borderColor={syncFetcher.data.isComplete ? "border-success" : "border-highlight"}
              >
                <BlockStack gap="200">
                  <Text variant="bodyMd" color={syncFetcher.data.isComplete ? "success" : "base"}>
                    {syncFetcher.data.isComplete 
                      ? `Sync completed: All ${syncFetcher.data.totalProducts || 0} products processed`
                      : syncFetcher.data.message
                    }
                  </Text>
                  {!syncFetcher.data.isComplete && (
                    <Text variant="bodySm" color="subdued">
                      🔄 Auto-continuing with remaining chunks...
                    </Text>
                  )}
                  {syncFetcher.data.chunkResults && (
                    <Text variant="bodySm" color="subdued">
                      📊 Progress: {syncFetcher.data.processedProducts || 0}/{syncFetcher.data.totalProducts || 0} products
                    </Text>
                  )}
                  {syncFetcher.data.isComplete && (
                    <BlockStack gap="100">
                      <Text variant="bodySm" color="success">
                        ✅ Updated: {cumulativeResults.updated} products
                      </Text>
                      <Text variant="bodySm" color="subdued">
                        ➖ No change: {cumulativeResults.noChange} products
                      </Text>
                      {cumulativeResults.errors > 0 && (
                        <Text variant="bodySm" color="warning">
                          ❌ Errors: {cumulativeResults.errors} products
                        </Text>
                      )}
                      {cumulativeResults.notFound > 0 && (
                        <Text variant="bodySm" color="subdued">
                          ⚠️ Not found: {cumulativeResults.notFound} products
                        </Text>
                      )}
                    </BlockStack>
                  )}
                </BlockStack>
              </Box>
            )}
          </BlockStack>
        </Card>

        {/* Shopify Buttons Section */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              Shopify Buttons
            </Text>
            <InlineStack gap="200" align="start">
              <Button 
                variant="secondary" 
                onClick={handleGetProducts}
                loading={productsFetcher.state === "submitting"}
              >
                Get Shopify Products
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>

        {/* Update Product Quantity Section */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              Update Product Quantity
            </Text>
            <BlockStack gap="200">
              <TextField
                label="Product SKU"
                value={sku}
                onChange={setSku}
                placeholder="Enter product SKU"
                autoComplete="off"
              />
              <TextField
                label="Quantity"
                type="number"
                value={quantity}
                onChange={setQuantity}
                placeholder="Enter quantity"
                min="1"
                autoComplete="off"
              />
              <Select
                label="Operation"
                options={[
                  {label: 'Add to inventory', value: 'add'},
                  {label: 'Subtract from inventory', value: 'subtract'},
                ]}
                value={mode}
                onChange={setMode}
              />
              <InlineStack gap="200" align="start">
                <Button 
                  variant="primary" 
                  onClick={handleUpdateQuantity}
                  loading={quantityFetcher.state === "submitting"}
                >
                  Update Quantity
                </Button>
              </InlineStack>
            </BlockStack>
            {quantityFetcher.data && (
              <Box
                padding="300"
                background={quantityFetcher.data.success ? "bg-surface-success" : "bg-surface-critical"}
                borderWidth="025"
                borderRadius="200"
                borderColor={quantityFetcher.data.success ? "border-success" : "border-critical"}
              >
                <BlockStack gap="200">
                  <Text variant="bodyMd" color={quantityFetcher.data.success ? "success" : "critical"}>
                    {quantityFetcher.data.success 
                      ? `✅ ${quantityFetcher.data.message}` 
                      : quantityFetcher.data.error
                    }
                  </Text>
                  
                  {quantityFetcher.data.success && (
                    <Box>
                      <Text variant="bodySm" as="p" color="subdued">
                        <strong>Product:</strong> {quantityFetcher.data.product}
                      </Text>
                      <Text variant="bodySm" as="p" color="subdued">
                        <strong>SKU:</strong> {quantityFetcher.data.sku}
                      </Text>
                      <Text variant="bodySm" as="p" color="subdued">
                        <strong>Operation:</strong> {quantityFetcher.data.operation === "add" ? "Added" : "Subtracted"} {quantityFetcher.data.quantityChanged} units
                      </Text>
                      <Text variant="bodySm" as="p" color="subdued">
                        <strong>Inventory:</strong> {quantityFetcher.data.previousQuantity} → {quantityFetcher.data.newQuantity}
                      </Text>
                      {quantityFetcher.data.location && (
                        <Text variant="bodySm" as="p" color="subdued">
                          <strong>Location:</strong> {quantityFetcher.data.location}
                        </Text>
                      )}
                    </Box>
                  )}
                  
                  {!quantityFetcher.data.success && quantityFetcher.data.hint && (
                    <Box>
                      <Text variant="bodySm" as="p" color="subdued">
                        💡 <strong>Hint:</strong> {quantityFetcher.data.hint}
                      </Text>
                    </Box>
                  )}
                  
                  {!quantityFetcher.data.success && quantityFetcher.data.details && (
                    <Box>
                      <Text variant="captionMd" as="p" color="subdued">
                        <strong>Details:</strong> {
                          typeof quantityFetcher.data.details === 'string' 
                            ? quantityFetcher.data.details 
                            : JSON.stringify(quantityFetcher.data.details)
                        }
                      </Text>
                    </Box>
                  )}
                </BlockStack>
              </Box>
            )}
          </BlockStack>
        </Card>

        {/* FINA Buttons Section */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              FINA Buttons
            </Text>
            <InlineStack gap="200" align="start" wrap={false}>
              <Button 
                variant="secondary" 
                onClick={handleGetFinaInfo}
                loading={finaFetcher.state === "submitting"}
              >
                Get FINA Info
              </Button>
              <Button 
                variant="secondary" 
                onClick={handleGetFinaProducts}
                loading={finaProductsFetcher.state === "submitting"}
              >
                Get FINA Products
              </Button>
              <Button 
                variant="secondary" 
                onClick={handleGetFinaCustomers}
                loading={finaCustomersFetcher.state === "submitting"}
              >
                Get FINA Customers
              </Button>
              <Button 
                variant="secondary" 
                onClick={handleGetFinaProductsByStore}
                loading={finaProductsByStoreFetcher.state === "submitting"}
              >
                Get FINA Products By Store
              </Button>
              <Button 
                variant="secondary" 
                onClick={handleGetFinaProductsAfterDate}
                loading={finaProductsAfterDateFetcher.state === "submitting"}
              >
                Get FINA Products After Date
              </Button>
            </InlineStack>
            
            {/* Input fields for APIs that require parameters */}
            <BlockStack gap="200">
              <Text as="h4" variant="headingSm">
                API Parameters
              </Text>
              <InlineStack gap="300" align="start">
                <Box minWidth="200px">
                  <TextField
                    label="Store ID (for Products By Store)"
                    value={storeId}
                    onChange={setStoreId}
                    placeholder="Enter store ID"
                    autoComplete="off"
                  />
                </Box>
                <Box minWidth="250px">
                  <TextField
                    label="After Date (for Products After Date)"
                    value={afterDate}
                    onChange={setAfterDate}
                    placeholder="2024-01-15T10:30:00"
                    helpText="Format: yyyy-MM-ddTHH:mm:ss"
                    autoComplete="off"
                  />
                </Box>
              </InlineStack>
            </BlockStack>
          </BlockStack>
        </Card>
        {finaFetcher.data && (
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingMd">
                FINA Info Response
              </Text>
              <Box
                padding="400"
                background="bg-surface-active"
                borderWidth="025"
                borderRadius="200"
                borderColor="border"
                overflowX="scroll"
              >
                <pre style={{ margin: 0, fontSize: "12px" }}>
                  <code>
                    {JSON.stringify(finaFetcher.data, null, 2)}
                  </code>
                </pre>
              </Box>
            </BlockStack>
          </Card>
        )}
        {finaProductsFetcher.data && (
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingMd">
                FINA Products Response
              </Text>
              <Box
                padding="400"
                background="bg-surface-active"
                borderWidth="025"
                borderRadius="200"
                borderColor="border"
                overflowX="scroll"
              >
                <pre style={{ margin: 0, fontSize: "12px" }}>
                  <code>
                    {JSON.stringify(finaProductsFetcher.data, null, 2)}
                  </code>
                </pre>
              </Box>
            </BlockStack>
          </Card>
        )}
        {finaCustomersFetcher.data && (
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingMd">
                FINA Customers Response
              </Text>
              <Box
                padding="400"
                background="bg-surface-active"
                borderWidth="025"
                borderRadius="200"
                borderColor="border"
                overflowX="scroll"
              >
                <pre style={{ margin: 0, fontSize: "12px" }}>
                  <code>
                    {JSON.stringify(finaCustomersFetcher.data, null, 2)}
                  </code>
                </pre>
              </Box>
            </BlockStack>
          </Card>
        )}
        {finaProductsByStoreFetcher.data && (
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingMd">
                FINA Products By Store Response
              </Text>
              <Box
                padding="400"
                background="bg-surface-active"
                borderWidth="025"
                borderRadius="200"
                borderColor="border"
                overflowX="scroll"
              >
                <pre style={{ margin: 0, fontSize: "12px" }}>
                  <code>
                    {JSON.stringify(finaProductsByStoreFetcher.data, null, 2)}
                  </code>
                </pre>
              </Box>
            </BlockStack>
          </Card>
        )}
        {finaProductsAfterDateFetcher.data && (
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingMd">
                FINA Products After Date Response
              </Text>
              <Box
                padding="400"
                background="bg-surface-active"
                borderWidth="025"
                borderRadius="200"
                borderColor="border"
                overflowX="scroll"
              >
                <pre style={{ margin: 0, fontSize: "12px" }}>
                  <code>
                    {JSON.stringify(finaProductsAfterDateFetcher.data, null, 2)}
                  </code>
                </pre>
              </Box>
            </BlockStack>
          </Card>
        )}
        {productsFetcher.data && (
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingMd">
                Shopify Products
              </Text>
              {productsFetcher.data.error ? (
                <Box
                  padding="400"
                  background="bg-surface-critical"
                  borderWidth="025"
                  borderRadius="200"
                  borderColor="border-critical"
                >
                  <Text variant="bodyMd" color="critical">
                    Error: {productsFetcher.data.error}
                  </Text>
                </Box>
              ) : (
                <Box
                  padding="400"
                  background="bg-surface-active"
                  borderWidth="025"
                  borderRadius="200"
                  borderColor="border"
                  overflowX="scroll"
                >
                  <pre style={{ margin: 0, fontSize: "12px" }}>
                    <code>
                      {JSON.stringify(productsFetcher.data, null, 2)}
                    </code>
                  </pre>
                </Box>
              )}
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
