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

    // 1. Agar Shopify Admin UI / Dashboard se request aayi ho
    try {
      const auth = await authenticate.admin(request);
      admin = auth.admin;
    } catch {
      // 2. Agar External Cron-Job se request aayi ho
      const url = new URL(request.url);
      const shopParam = url.searchParams.get("shop") || "yppy8z-d9.myshopify.com";

      // Database se session uthayen
      let session = await prisma.session.findFirst({
        where: { shop: { contains: shopParam.replace(".myshopify.com", "") } },
        orderBy: { id: "desc" },
      });

      if (!session) {
        session = await prisma.session.findFirst({
          orderBy: { id: "desc" },
        });
      }

      if (!session || !session.accessToken) {
        return jsonResponse(
          {
            success: false,
            error: "Shopify session not found. Please open the App Dashboard once to initialize session.",
          },
          200
        );
      }

      // Graphql client direct session se banayein
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

    // 3. Cutoff Date: Aaj se 3 months purani date
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - 3);

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
    console.error("B2G1 Sync Error:", error);
    return jsonResponse({ success: false, error: error.message }, 500);
  }
};