import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  try {
    const { admin } = await authenticate.admin(request);

    // Aaj se 3 months (90 din) pehle ki date
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

        // Agar release_date metafield khali hai to skip
        if (!product.releaseDate?.value) continue;

        const releaseDate = new Date(product.releaseDate.value);
        const isEligible = releaseDate <= cutoffDate;

        // Rule 1: 3 months se purana hai aur exclude nahi kiya
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
        } 
        // Rule 2: Agar client ne 'exclude-b2g1' laga diya ya date naye product ki hai
        else {
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

    return json({ success: true, updatedCount });
  } catch (error) {
    console.error("B2G1 Sync Error:", error);
    return json({ success: false, error: error.message }, { status: 500 });
  }
};