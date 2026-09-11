// app/routes/api.cron.notify-live-products.jsx

import shopify from "../shopify.server";

const CRON_SECRET = process.env.CRON_SECRET;
const SHOP_DOMAIN = process.env.SHOP_DOMAIN || "yppy8z-d9.myshopify.com";

export async function action({ request }) {
  try {
    // --- 1. Auth check: Cron secret verification ---
    const incomingSecret = request.headers.get("x-cron-secret");
    if (!CRON_SECRET || incomingSecret !== CRON_SECRET) {
      return Response.json({ error: "Unauthorized: Invalid or missing x-cron-secret" }, { status: 401 });
    }

    // --- 2. Load Offline Session ---
    const domainsToTry = [
      SHOP_DOMAIN,
      "yppy8z-d9.myshopify.com",
      "leapslair.myshopify.com"
    ];

    let offlineSession = null;
    let connectedDomain = "";

    for (const domain of domainsToTry) {
      try {
        const sessions = await shopify.sessionStorage.findSessionsByShop(domain);
        const found = sessions.find((s) => !s.isOnline);
        if (found) {
          offlineSession = found;
          connectedDomain = domain;
          break;
        }
      } catch (e) {
        // Continue searching
      }
    }

    if (!offlineSession) {
      return Response.json(
        { 
          error: "No offline session found.",
          details: `Searched in: ${domainsToTry.join(", ")}. Please open the app in Shopify Admin once to authenticate.` 
        },
        { status: 500 }
      );
    }

    // --- 3. GraphQL Query Helper (Using unauthenticated.admin or direct admin context) ---
    const { admin } = await shopify.unauthenticated.admin(connectedDomain);

    // Pull products having drop_date metafield
    const productsResponse = await admin.graphql(
      `#graphql
        query {
          products(first: 100, query: "metafields.custom.drop_date:*") {
            edges {
              node {
                id
                handle
                title
                onlineStorePreviewUrl
                dropDate: metafield(namespace: "custom", key: "drop_date") { value }
                notified: metafield(namespace: "custom", key: "notify_sent") { value }
              }
            }
          }
        }
      `
    );

    const productsJson = await productsResponse.json();
    const products = productsJson.data?.products?.edges?.map((e) => e.node) || [];
    const now = new Date();
    const results = [];

    for (const product of products) {
      if (!product.dropDate?.value) continue;
      if (product.notified?.value === "true") continue;

      const dropDate = new Date(product.dropDate.value);
      if (dropDate > now) continue; // Still in future, skip

      // --- 4. Find customers tagged notify_{{product.handle}} ---
      const tag = `notify_${product.handle}`;
      const customersResponse = await admin.graphql(
        `#graphql
          query getCustomers($searchQuery: String!) {
            customers(first: 250, query: $searchQuery) {
              edges {
                node {
                  id
                  email
                  firstName
                }
              }
            }
          }
        `,
        {
          variables: { searchQuery: `tag:'${tag}'` },
        }
      );

      const customersJson = await customersResponse.json();
      const customers = customersJson.data?.customers?.edges?.map((e) => e.node) || [];

      // --- 5. Clean Storefront URL ---
      const productUrl = `https://leapslair.com/products/${product.handle}`;
      let sentCount = 0;

      for (const customer of customers) {
        if (!customer.email) continue;
        try {
          await sendNotifyEmail({
            to: customer.email,
            firstName: customer.firstName,
            productTitle: product.title,
            productUrl,
          });
          sentCount++;
        } catch (err) {
          console.error(`Failed to email ${customer.email} for ${product.handle}:`, err);
        }
      }

      // --- 6. Mark product as notified ---
      await admin.graphql(
        `#graphql
          mutation setNotified($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              userErrors { field message }
            }
          }
        `,
        {
          variables: {
            metafields: [
              {
                ownerId: product.id,
                namespace: "custom",
                key: "notify_sent",
                type: "boolean",
                value: "true",
              },
            ],
          },
        }
      );

      results.push({
        product: product.title,
        handle: product.handle,
        customersTagged: customers.length,
        emailsSent: sentCount,
      });
    }

    return Response.json({
      ok: true,
      shop: connectedDomain,
      checkedProducts: products.length,
      results,
    });

  } catch (error) {
    console.error("Cron Error:", error);
    return Response.json(
      { error: "Internal Server Error", message: error.message, stack: error.stack },
      { status: 500 }
    );
  }
}

// -----------------------------------------------------------------------
// Email Provider stub (Resend / Sendgrid / Klaviyo)
// -----------------------------------------------------------------------
async function sendNotifyEmail({ to, firstName, productTitle, productUrl }) {
  console.log(`[Email Triggered] To: ${to} | Product: ${productTitle} | URL: ${productUrl}`);
}