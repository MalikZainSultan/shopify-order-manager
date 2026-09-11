// app/routes/api.cron.notify-live-products.jsx
//
// Purpose: Called by an external cron (cron-job.org) or Render Cron Job every
// 1 minute. Checks all products with a `custom.drop_date` metafield that has
// already passed, and hasn't been notified yet, then:
//   1. Finds all customers tagged `notify_{{product.handle}}`
//   2. Sends them a "now live" email (plug in your email provider below)
//   3. Marks the product as notified (custom.notify_sent = true) so we never
//      double-email on the next run
//
// This does NOT touch the storefront Liquid — that logic (hiding Add to Cart /
// showing the Notify Me box) still runs purely off `custom.drop_date` being
// blank or in the future, same as before. This route only handles the EMAIL side.

import shopify from "../shopify.server";

const CRON_SECRET = process.env.CRON_SECRET;
const SHOP_DOMAIN = process.env.SHOP_DOMAIN; // e.g. "leapslair.myshopify.com"

export async function action({ request }) {
  // --- 1. Auth check: only our own cron caller can hit this ---
  const incomingSecret = request.headers.get("x-cron-secret");
  if (!CRON_SECRET || incomingSecret !== CRON_SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!SHOP_DOMAIN) {
    return Response.json({ error: "SHOP_DOMAIN env var is not set" }, { status: 500 });
  }

  // --- 2. Load the shop's offline (non-expiring) session so we can call the Admin API ---
  const sessions = await shopify.sessionStorage.findSessionsByShop(SHOP_DOMAIN);
  const offlineSession = sessions.find((s) => !s.isOnline);

  if (!offlineSession) {
    return Response.json(
      { error: `No offline session found for ${SHOP_DOMAIN}. Re-install/auth the app once.` },
      { status: 500 }
    );
  }

  const client = new shopify.api.clients.Graphql({ session: offlineSession });

  // --- 3. Pull all products that HAVE a drop_date metafield set ---
  // NOTE: confirm this search syntax works on your API version — Shopify's
  // product search-by-metafield syntax has changed across versions. If this
  // returns nothing, fall back to paginating ALL products and filtering
  // client-side on `dropDate.value` instead (slower but always works).
  const productsResponse = await client.query({
    data: `#graphql
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
    `,
  });

  const products = productsResponse.body.data.products.edges.map((e) => e.node);
  const now = new Date();
  const results = [];

  for (const product of products) {
    if (!product.dropDate?.value) continue; // no drop_date set — skip
    if (product.notified?.value === "true") continue; // already notified — skip

    const dropDate = new Date(product.dropDate.value);
    if (dropDate > now) continue; // still in the future — skip, not live yet

    // --- 4. Find customers tagged notify_{{product.handle}} ---
    const tag = `notify_${product.handle}`;
    const customersResponse = await client.query({
      data: `#graphql
        query($searchQuery: String!) {
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
      variables: { searchQuery: `tag:'${tag}'` },
    });

    const customers = customersResponse.body.data.customers.edges.map((e) => e.node);

    // --- 5. Send the email (plug in your provider inside sendNotifyEmail) ---
    const productUrl = `https://${SHOP_DOMAIN.replace(".myshopify.com", "")}/products/${product.handle}`;
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

    // --- 6. Mark product as notified so we never re-send on future runs ---
    await client.query({
      data: `#graphql
        mutation($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors { field message }
          }
        }
      `,
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
    });

    results.push({
      product: product.title,
      handle: product.handle,
      customersTagged: customers.length,
      emailsSent: sentCount,
    });
  }

  return Response.json({ ok: true, checkedProducts: products.length, results });
}

// -----------------------------------------------------------------------
// Plug in your real email provider here. Below is a ready-to-uncomment
// example for Resend (https://resend.com) — swap for SendGrid/Klaviyo/etc.
// as needed. Until this is wired up, it just logs (no email is sent).
// -----------------------------------------------------------------------
async function sendNotifyEmail({ to, firstName, productTitle, productUrl }) {
  // Example: Resend
  // const res = await fetch("https://api.resend.com/emails", {
  //   method: "POST",
  //   headers: {
  //     Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
  //     "Content-Type": "application/json",
  //   },
  //   body: JSON.stringify({
  //     from: "LeapsLair <orders@leapslair.com>",
  //     to,
  //     subject: `${productTitle} is live — grab yours now!`,
  //     html: `
  //       <p>Hi ${firstName || "there"},</p>
  //       <p><strong>${productTitle}</strong> is now available for pre-order!</p>
  //       <p><a href="${productUrl}">Click here to order now</a> before it sells out.</p>
  //     `,
  //   }),
  // });
  // if (!res.ok) throw new Error(`Resend API error: ${res.status}`);

  console.log(`[stub — no email service configured yet] Would email ${to} about "${productTitle}"`);
}
