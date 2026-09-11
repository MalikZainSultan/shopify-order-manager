// app/routes/api.cron.notify-live-products.jsx

import shopify from "../shopify.server";

const CRON_SECRET = process.env.CRON_SECRET;
const SHOP_DOMAIN = process.env.SHOP_DOMAIN || "yppy8z-d9.myshopify.com";
const RESEND_API_KEY = process.env.RESEND_API_KEY;

async function handleCronJob(request) {
  try {
    // --- 1. Auth check ---
    const url = new URL(request.url);
    const headerSecret = request.headers.get("x-cron-secret");
    const querySecret = url.searchParams.get("secret");
    const incomingSecret = headerSecret || querySecret;

    if (!CRON_SECRET || incomingSecret !== CRON_SECRET) {
      return Response.json({ error: "Unauthorized: Invalid or missing secret" }, { status: 401 });
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
      } catch (e) {}
    }

    if (!offlineSession) {
      return Response.json(
        { 
          error: "No offline session found.",
          details: `Searched in: ${domainsToTry.join(", ")}. Open app once in Shopify admin.` 
        },
        { status: 500 }
      );
    }

    // --- 3. GraphQL Client via unauthenticated admin context ---
    const { admin } = await shopify.unauthenticated.admin(connectedDomain);

    // Pull products with metafields
    const productsResponse = await admin.graphql(
      `#graphql
        query getDropProducts {
          products(first: 50) {
            edges {
              node {
                id
                handle
                title
                dropDate: metafield(namespace: "custom", key: "drop_date") { value }
                notified: metafield(namespace: "custom", key: "notify_sent") { value }
              }
            }
          }
        }
      `
    );

    const productsJson = await productsResponse.json();
    const allProducts = productsJson.data?.products?.edges?.map((e) => e.node) || [];
    
    // Filter only products that have drop_date set
    const dropProducts = allProducts.filter((p) => p.dropDate?.value);

    const now = new Date();
    const results = [];
    const skippedDetails = [];

    for (const product of dropProducts) {
      // Check if already notified
      if (product.notified?.value === "true") {
        skippedDetails.push({ handle: product.handle, reason: "Already notified (notify_sent = true)" });
        continue;
      }

      const dropDate = new Date(product.dropDate.value);

      // Check if date is still in future
      if (dropDate > now) {
        skippedDetails.push({
          handle: product.handle,
          dropDate: product.dropDate.value,
          currentTimeUTC: now.toISOString(),
          reason: "Drop date is still in future"
        });
        continue;
      }

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
                  tags
                }
              }
            }
          }
        `,
        {
          variables: { searchQuery: `tag:${tag}` },
        }
      );

      const customersJson = await customersResponse.json();
      const customers = customersJson.data?.customers?.edges?.map((e) => e.node) || [];

      // --- 5. Dispatch Notification Emails ---
      const productUrl = `https://leapslair.com/products/${product.handle}`;
      let sentCount = 0;
      const emailErrors = [];

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
          console.error(`Email error for ${customer.email}:`, err);
          emailErrors.push({ email: customer.email, error: err.message });
        }
      }

      // --- 6. Mark product as notified (Only if at least attempted or processed) ---
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
        matchedTag: tag,
        customersFound: customers.length,
        emailsSent: sentCount,
        emailErrors,
      });
    }

    return Response.json({
      ok: true,
      shop: connectedDomain,
      totalProductsWithDropDate: dropProducts.length,
      processedLiveProducts: results.length,
      results,
      skippedDetails,
    });

  } catch (error) {
    console.error("Cron Error:", error);
    return Response.json(
      { error: "Internal Server Error", message: error.message, stack: error.stack },
      { status: 500 }
    );
  }
}

export async function loader({ request }) {
  return handleCronJob(request);
}

export async function action({ request }) {
  return handleCronJob(request);
}

// -----------------------------------------------------------------------
// Email Provider function
// -----------------------------------------------------------------------
async function sendNotifyEmail({ to, firstName, productTitle, productUrl }) {
  if (!RESEND_API_KEY) {
    console.log(`[STUB EMAIL] No RESEND_API_KEY set. Would send to: ${to} for "${productTitle}"`);
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "LeapsLair <notifications@leapslair.com>", // ya testing ke liye "onboarding@resend.dev"
      to: [to],
      subject: `🚨 ${productTitle} is NOW LIVE!`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2>Hey ${firstName || "Collector"},</h2>
          <p>Great news! The drop you were waiting for, <strong>${productTitle}</strong>, is officially live now.</p>
          <p style="margin: 25px 0;">
            <a href="${productUrl}" style="background-color: #111; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
              Order Now Before It Sells Out &rarr;
            </a>
          </p>
          <p style="color: #666; font-size: 13px;">If the button above does not work, visit: <br/>${productUrl}</p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Resend Error ${res.status}: ${errBody}`);
  }
}