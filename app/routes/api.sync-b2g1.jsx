import prisma from "../db.server";
import shopify, { authenticate } from "../shopify.server";

const jsonResponse = (data, status = 200) => {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};

// Rate-limiting delay helper
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const loader = async ({ request }) => {
  try {
    let admin = null;

    // 1. Shopify Admin UI / Dashboard ya External Cron session
    try {
      const auth = await authenticate.admin(request);
      admin = auth.admin;
    } catch {
      const url = new URL(request.url);
      const shopParam = url.searchParams.get("shop") || "yppy8z-d9.myshopify.com";

      const session = await prisma.session.findFirst({
        where: { shop: { contains: shopParam.replace(".myshopify.com", "") } },
        orderBy: { id: "desc" },
      }) || await prisma.session.findFirst({
        orderBy: { id: "desc" },
      });

      if (!session) {
        return jsonResponse({
          success: false,
          message: "No active session found in database.",
        }, 200);
      }

      const client = new shopify.api.clients.Graphql({ session });
      admin = {
        graphql: async (query, options) => {
          const res = await client.query({
            data: { query, variables: options?.variables },
          });
          return { json: async () => res.body };
        },
      };
    }

    // 2. Cutoff Date: Aaj se 90 din (3 months) pehle
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);

    let hasNextPage = true;
    let cursor = null;
    let updatedCount = 0;

    while (hasNextPage) {
      const response = await admin.graphql(
        `#graphql
        query getProductsForB2G1($cursor: String) {
          products(first: 50, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              title
              tags
              releaseDate: metafield(namespace: "custom", key: "release_date") {
                value
              }
            }
          }
        }`,
        { variables: { cursor } }
      );

      const payload = await response.json();
      const products = payload.data?.products?.nodes || [];

      for (const product of products) {
        const tags = product.tags || [];
        const hasExclude = tags.includes("exclude-b2g1");
        const hasTag = tags.includes("b2g1-eligible");

        // Agar release date missing ya empty ho to skip karein (Crash se bachata hai)
        if (!product.releaseDate?.value || product.releaseDate.value.trim() === "") {
          continue;
        }

        const releaseDate = new Date(product.releaseDate.value);
        if (isNaN(releaseDate.getTime())) {
          continue; // Invalid date format par crash nahi hone dega
        }

        const isEligible = releaseDate <= cutoffDate;

        if (isEligible && !hasExclude) {
          if (!hasTag) {
            await admin.graphql(
              `#graphql
              mutation addTag($id: ID!, $tags: [String!]!) {
                tagsAdd(id: $id, tags: $tags) {
                  userErrors { message }
                }
              }`,
              { variables: { id: product.id, tags: ["b2g1-eligible"] } }
            );
            updatedCount++;
            await sleep(50); // Shopify rate limit safe pause
          }
        } else {
          if (hasTag) {
            await admin.graphql(
              `#graphql
              mutation removeTag($id: ID!, $tags: [String!]!) {
                tagsRemove(id: $id, tags: $tags) {
                  userErrors { message }
                }
              }`,
              { variables: { id: product.id, tags: ["b2g1-eligible"] } }
            );
            updatedCount++;
            await sleep(50); // Shopify rate limit safe pause
          }
        }
      }

      hasNextPage = payload.data?.products?.pageInfo?.hasNextPage || false;
      cursor = payload.data?.products?.pageInfo?.endCursor || null;
    }

    return jsonResponse({ success: true, updatedCount });
  } catch (error) {
    console.error("B2G1 Sync Error:", error);
    // Hamesha 200 return karega taake front-end ya cron 500 error pe crash na ho
    return jsonResponse({ success: false, error: error.message || "Unknown sync error" }, 200);
  }
};