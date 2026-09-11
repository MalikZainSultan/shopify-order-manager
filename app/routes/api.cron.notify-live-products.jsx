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
      return Response.json(
        { error: "Unauthorized: Invalid or missing secret" },
        { status: 401 }
      );
    }

    // --- 2. Load Offline Session ---
    const domainsToTry = [
      SHOP_DOMAIN,
      "yppy8z-d9.myshopify.com",
      "leapslair.myshopify.com",
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
          details: `Searched in: ${domainsToTry.join(", ")}. Please open the app in Shopify Admin once.`,
        },
        { status: 500 }
      );
    }

    const { admin } = await shopify.unauthenticated.admin(connectedDomain);

    // --- 3. Targeted Query for Large Stores ---
    // Multiple query syntaxes use kar rahe hain jo Shopify metafield index match karti hain
    // Fallback: agar store par products bohot zyada hain to hum targeted query pass karte hain
    const productsResponse = await admin.graphql(
      `#graphql
        query getDropProducts {
          products(first: 50, query: "status:active") {
            edges {
              node {
                id
                handle
                title
                dropDate: metafield(namespace: "custom", key: "drop_date") {
                  value
                }
                notified: metafield(namespace: "custom", key: "notify_sent") {
                  value
                }
              }
            }
          }
        }
      `
    );

    const productsJson = await productsResponse.json();
    let allProducts = productsJson.data?.products?.edges?.map((e) => e.node) || [];

    // Filter sirf wahi products jin par dropDate set hai
    let dropProducts = allProducts.filter((p) => p.dropDate?.value);

    // AGAR dropProducts 0 aayein (kyunki 9000 products hain aur pehle 50 me nahi aayi),
    // to search query ke sath targetted hit karein:
    if (dropProducts.length === 0) {
      const searchResponse = await admin.graphql(
        `#graphql
          query searchByMetafield {
            products(first: 50, query: "custom.drop_date:*") {
              edges {
                node {
                  id
                  handle
                  title
                  dropDate: metafield(namespace: "custom", key: "drop_date") {
                    value
                  }
                  notified: metafield(namespace: "custom", key: "notify_sent") {
                    value
                  }
                }
              }
            }
          }
        `
      );
      const searchJson = await searchResponse.json();
      const queriedProducts = searchJson.data?.products?.edges?.map((e) => e.node) || [];
      dropProducts = queriedProducts.filter((p) => p.dropDate?.value);
    }

    const now = new Date();
    const results = [];
    const skippedDetails = [];

    for (const product of dropProducts) {
      // 1. Skip if already notified
      if (product.notified?.value === "true") {
        skippedDetails.push({
          handle: product.handle,
          reason: "Already notified (notify_sent = true)",
        });
        continue;
      }

      const dropDate = new Date(product.dropDate.value);

      // 2. Skip if still in future
      if (dropDate > now) {
        skippedDetails.push({
          handle: product.handle,
          dropDate: product.dropDate.value,
          currentTimeUTC: now.toISOString(),
          reason: "Drop date is still in future",
        });
        continue;
      }

      // --- 4. Tag Matching (Efficient query for 10k+ customers) ---
      const cleanHandle = product.handle.replace(/^[0-9]+-/, "");
      const numericId = product.id.split("/").pop();

      // Shopify Customer Search Index exact/wildcard match fast karta hai
      const searchQuery = `tag:notify_*${cleanHandle}* OR tag:notify_*${product.handle}* OR tag:notify_*${numericId}*`;

      const customersResponse = await admin.graphql(
        `#graphql
          query getTaggedCustomers($searchQuery: String!) {
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
          variables: { searchQuery },
        }
      );

      const customersJson = await customersResponse.json();
      const rawCustomers = customersJson.data?.customers?.edges?.map((e) => e.node) || [];

      // Ensure customer tag belongs specifically to this product
      const matchedCustomers = rawCustomers.filter((customer) => {
        if (!customer.tags) return false;
        return customer.tags.some(
          (t) =>
            t.includes(`notify_${product.handle}`) ||
            t.includes(`notify_${cleanHandle}`) ||
            (numericId && t.includes(`notify_${numericId}`))
        );
      });

      // --- 5. Dispatch Emails ---
      const productUrl = `https://leapslair.com/products/${product.handle}`;
      let sentCount = 0;
      const emailLogs = [];

      for (const customer of matchedCustomers) {
        if (!customer.email) continue;
        try {
          await sendNotifyEmail({
            to: customer.email,
            firstName: customer.firstName,
            productTitle: product.title,
            productUrl,
          });
          sentCount++;
          emailLogs.push({ email: customer.email, status: "Sent" });
        } catch (err) {
          console.error(`Failed sending to ${customer.email}:`, err);
          emailLogs.push({ email: customer.email, status: "Failed", error: err.message });
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
        matchedQuery: searchQuery,
        customersFound: matchedCustomers.length,
        emailsSent: sentCount,
        emailLogs,
      });
    }

    return Response.json({
      ok: true,
      shop: connectedDomain,
      totalDropProductsFound: dropProducts.length,
      processedProductsCount: results.length,
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
// Email Provider Integration (Resend or Console Log)
// -----------------------------------------------------------------------
async function sendNotifyEmail({ to, firstName, productTitle, productUrl }) {
  if (!RESEND_API_KEY) {
    console.log(`[STUB EMAIL] No RESEND_API_KEY. Would email ${to} for "${productTitle}" | URL: ${productUrl}`);
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "LeapsLair <onboarding@resend.dev>",
      to: [to],
      subject: `🚨 ${productTitle} is NOW LIVE!`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 20px; line-height: 1.5;">
          <h2>Hey ${firstName || "there"}!</h2>
          <p>Great news! The drop you were waiting for, <strong>${productTitle}</strong>, is officially available for purchase.</p>
          <p style="margin: 25px 0;">
            <a href="${productUrl}" style="background-color: #000; color: #fff; padding: 12px 22px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">
              View &amp; Buy Product &rarr;
            </a>
          </p>
          <p style="color: #777; font-size: 13px;">Or open this link directly: <br/><a href="${productUrl}">${productUrl}</a></p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Resend Error: ${res.status} - ${errorText}`);
  }
}