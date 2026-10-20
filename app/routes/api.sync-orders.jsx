import prisma from "../db.server";
import shopify, { authenticate } from "../shopify.server";

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

    // 1. Session Auth (Same as before)
    try {
      const auth = await authenticate.admin(request);
      admin = auth.admin;
    } catch {
      const url = new URL(request.url);
      const shopParam = url.searchParams.get("shop") || "yppy8z-d9.myshopify.com";

      const session =
        (await prisma.session.findFirst({
          where: {
            shop: { contains: shopParam.replace(".myshopify.com", "") },
          },
          orderBy: { id: "desc" },
        })) ||
        (await prisma.session.findFirst({
          orderBy: { id: "desc" },
        }));

      if (!session) {
        return jsonResponse(
          { success: false, message: "No active session in database." },
          200
        );
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

    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor") || null;

    // 2. Fetch full 250 orders batch with cursor pagination
    const response = await admin.graphql(DETAILED_ORDERS_CHUNK_QUERY, {
      variables: { cursor },
    });

    const payload = await response.json();

    if (payload.errors) {
      console.error("Shopify GraphQL Sync Error:", payload.errors);
      return jsonResponse(
        {
          success: false,
          error: payload.errors[0]?.message || "GraphQL query error",
          orders: [],
          hasNextPage: false,
        },
        200
      );
    }

    const ordersData = payload.data?.orders;
    const orders = ordersData?.edges ? ordersData.edges.map((e) => e.node) : [];
    const hasNextPage = Boolean(ordersData?.pageInfo?.hasNextPage);
    const endCursor = ordersData?.pageInfo?.endCursor || null;

    // 3. Return both original heartbeat properties + new Ajax sync data
    return jsonResponse({
      success: true,
      message: "Order sync heartbeat active",
      orders,
      syncedCount: orders.length,
      latestOrder: orders[0]?.name || null,
      hasNextPage,
      endCursor,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Order Sync Error:", error);
    return jsonResponse({ success: false, error: error.message }, 200);
  }
};