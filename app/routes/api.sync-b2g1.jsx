import prisma from "../db.server";
import shopify, { authenticate } from "../shopify.server";

const jsonResponse = (data, status = 200) => {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};

export const loader = async ({ request }) => {
  try {
    let admin = null;

    // 1. Shopify App Dashboard se request aaye
    try {
      const auth = await authenticate.admin(request);
      admin = auth.admin;
    } catch {
      // 2. External Cron Job se request aaye
      const url = new URL(request.url);
      const shopParam = url.searchParams.get("shop") || "yppy8z-d9.myshopify.com";

      const session = await prisma.session.findFirst({
        where: {
          shop: {
            contains: shopParam.replace(".myshopify.com", ""),
          },
        },
        orderBy: { id: "desc" },
      }) || await prisma.session.findFirst({
        orderBy: { id: "desc" },
      });

      if (!session) {
        return jsonResponse({
          success: false,
          message: "No active session in database. Please open App Dashboard once.",
        }, 200);
      }

      // Shopify client initialize
      const client = new shopify.api.clients.Graphql({ session });
      admin = {
        graphql: async (query, options) => {
          const res = await client.query({
            data: {
              query,
              variables: options?.variables,
            },
          });
          return {
            json: async () => res.body,
          };
        },
      };
    }

    // 3. Cutoff Date: Aaj se 90 din (3 months) pehle
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

        if (!product.releaseDate?.value) continue;

        const releaseDate = new Date(product.releaseDate.value);
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
          }
        }
      }

      hasNextPage = payload.data?.products?.pageInfo?.hasNextPage || false;
      cursor = payload.data?.products?.pageInfo?.endCursor || null;
    }

    return jsonResponse({ success: true, updatedCount });
  } catch (error) {
    console.error("Cron Error Log:", error);
    return jsonResponse({ success: false, error: error.message || "Unknown error" }, 200);
  }
};