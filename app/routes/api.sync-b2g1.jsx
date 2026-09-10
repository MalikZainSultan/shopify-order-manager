import prisma from "../db.server";
import shopify from "../shopify.server";

const jsonResponse = (data, status = 200) => {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};

export const loader = async ({ request }) => {
  try {
    // 1. Session dhoondein (Chahe Shopify Admin se ho ya external Cron Job se)
    let adminClient = null;

    try {
      const auth = await shopify.authenticate.admin(request);
      adminClient = auth.admin;
    } catch (e) {
      // Agar external cron-job se call aayi hai to database se offline session uthayen
      const session = await prisma.session.findFirst({
        where: { isOnline: false },
        orderBy: { id: "desc" },
      }) || await prisma.session.findFirst({
        orderBy: { id: "desc" },
      });

      if (!session) {
        return jsonResponse({ success: false, error: "No active Shopify session found in database." }, 401);
      }

      const client = new shopify.api.clients.Graphql({ session });
      adminClient = {
        graphql: async (query, options) => {
          return client.query({
            data: {
              query,
              variables: options?.variables,
            },
          });
        },
      };
    }

    // 2. Cutoff date: Aaj se 3 months purani date
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - 3);

    let hasNextPage = true;
    let cursor = null;
    let updatedCount = 0;

    while (hasNextPage) {
      const response = await adminClient.graphql(
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

      const payload = response.body ? response.body : await response.json();
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
            await adminClient.graphql(
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
            await adminClient.graphql(
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