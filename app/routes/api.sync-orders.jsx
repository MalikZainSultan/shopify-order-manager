import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const jsonResponse = (data, status = 200) => {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};

const DETAILED_ORDERS_CHUNK_QUERY = `#graphql
  query FetchOrdersChunk($cursor: String) {
    orders(
      first: 250
      after: $cursor
      sortKey: CREATED_AT
      reverse: true
      query: "status:any"
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          name
          createdAt
          cancelledAt
          cancelReason
          displayFulfillmentStatus
          displayFinancialStatus
          tags
          customer {
            id
            firstName
            lastName
            tags
          }
          email
          shippingAddress {
            name
            address1
            address2
            city
            zip
            country
          }
          lineItems(first: 50) {
            edges {
              node {
                id
                title
                variantTitle
                sku
                quantity
                unfulfilledQuantity
                product {
                  id
                  tags
                  metafield(namespace: "custom", key: "release_date") {
                    value
                  }
                  focMetafield: metafield(namespace: "custom", key: "foc_date") {
                    value
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const loader = async ({ request }) => {
  try {
    let admin = null;

    // 1. Shopify Authenticated Admin Session Check
    try {
      const auth = await authenticate.admin(request);
      admin = auth.admin;
    } catch {
      const session = await prisma.session.findFirst({
        orderBy: { id: "desc" },
      });

      if (!session) {
        return jsonResponse({ success: false, message: "Session expired in database." }, 401);
      }

      // Fallback direct Graphql Client
      admin = {
        graphql: async (query, options) => {
          const endpoint = `https://${session.shop}/admin/api/2024-04/graphql.json`;
          return fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": session.accessToken,
            },
            body: JSON.stringify({ query, variables: options?.variables }),
          });
        },
      };
    }

    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor") || null;

    const response = await admin.graphql(DETAILED_ORDERS_CHUNK_QUERY, {
      variables: { cursor },
    });

    const payload = await response.json();

    if (payload.errors) {
      console.error("Shopify GraphQL Error:", payload.errors);
      return jsonResponse({
        success: false,
        error: payload.errors[0]?.message || "GraphQL error",
        orders: [],
        hasNextPage: false,
      });
    }

    const ordersData = payload.data?.orders;
    const orders = ordersData?.edges ? ordersData.edges.map((e) => e.node) : [];
    const hasNextPage = Boolean(ordersData?.pageInfo?.hasNextPage);
    const endCursor = ordersData?.pageInfo?.endCursor || null;

    return jsonResponse({
      success: true,
      orders,
      syncedCount: orders.length,
      hasNextPage,
      endCursor,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("API Order Sync Error:", error);
    return jsonResponse({ success: false, error: error.message }, 500);
  }
};