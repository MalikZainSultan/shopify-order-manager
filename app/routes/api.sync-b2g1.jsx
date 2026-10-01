import prisma from "../db.server";
import shopify, { authenticate } from "../shopify.server";

const jsonResponse = (data, status = 200) => {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};

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

      const session =
        (await prisma.session.findFirst({
          where: { shop: { contains: shopParam.replace(".myshopify.com", "") } },
          orderBy: { id: "desc" },
        })) ||
        (await prisma.session.findFirst({
          orderBy: { id: "desc" },
        }));

      if (!session) {
        return jsonResponse({
          success: false,
          error: "No active session found in database.",
        });
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

      if (payload.errors) {
        const errorMsg = payload.errors.map((e) => e.message).join(", ");
        throw new Error(errorMsg);
      }

      const products = payload.data?.products?.nodes || [];

      for (const product of products) {
        const tags = product.tags || [];
        const hasExclude = tags.includes("exclude-b2g1");
        const hasTag = tags.includes("b2g1-eligible");

        if (!product.releaseDate?.value || product.releaseDate.value.trim() === "") {
          continue;
        }

        const releaseDate = new Date(product.releaseDate.value);
        if (isNaN(releaseDate.getTime())) {
          continue;
        }

        const isEligible = releaseDate <= cutoffDate;

        if (isEligible && !hasExclude) {
          if (!hasTag) {
            const addRes = await admin.graphql(
              `#graphql
              mutation addTag($id: ID!, $tags: [String!]!) {
                tagsAdd(id: $id, tags: $tags) {
                  userErrors { message field }
                }
              }`,
              { variables: { id: product.id, tags: ["b2g1-eligible"] } }
            );

            const addPayload = await addRes.json();
            if (addPayload.errors) {
              throw new Error(addPayload.errors[0]?.message || "Access denied on tagsAdd");
            }
            if (addPayload.data?.tagsAdd?.userErrors?.length > 0) {
              console.warn("tagsAdd UserError:", addPayload.data.tagsAdd.userErrors);
            } else {
              updatedCount++;
            }
            await sleep(60);
          }
        } else {
          if (hasTag) {
            const remRes = await admin.graphql(
              `#graphql
              mutation removeTag($id: ID!, $tags: [String!]!) {
                tagsRemove(id: $id, tags: $tags) {
                  userErrors { message field }
                }
              }`,
              { variables: { id: product.id, tags: ["b2g1-eligible"] } }
            );

            const remPayload = await remRes.json();
            if (remPayload.errors) {
              throw new Error(remPayload.errors[0]?.message || "Access denied on tagsRemove");
            }
            if (remPayload.data?.tagsRemove?.userErrors?.length > 0) {
              console.warn("tagsRemove UserError:", remPayload.data.tagsRemove.userErrors);
            } else {
              updatedCount++;
            }
            await sleep(60);
          }
        }
      }

      hasNextPage = payload.data?.products?.pageInfo?.hasNextPage || false;
      cursor = payload.data?.products?.pageInfo?.endCursor || null;
    }

    return jsonResponse({ success: true, updatedCount });
  } catch (error) {
    console.error("B2G1 Sync Error:", error);
    
    // Agar scope issue ho to front-end par helpful guideline message jaye
    let readableError = error.message || "Unknown sync error";
    if (readableError.includes("Access denied for tagsAdd") || readableError.includes("Access denied")) {
      readableError = "Shopify Permission Missing: Please add 'write_products' scope in shopify.app.toml and re-authenticate the app.";
    }

    return jsonResponse({ success: false, error: readableError }, 200);
  }
};