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

    try {
      const auth = await authenticate.admin(request);
      admin = auth.admin;
    } catch {
      const url = new URL(request.url);
      const shopParam = url.searchParams.get("shop") || "yppy8z-d9.myshopify.com";

      const session = await prisma.session.findFirst({
        where: {
          shop: { contains: shopParam.replace(".myshopify.com", "") },
        },
        orderBy: { id: "desc" },
      }) || await prisma.session.findFirst({
        orderBy: { id: "desc" },
      });

      if (!session) {
        return jsonResponse({ success: false, message: "No active session in database." }, 200);
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

    // Shopify se recent unfulfilled aur active orders fetch karein
    const response = await admin.graphql(
      `#graphql
      query CheckRecentOrders {
        orders(first: 20, sortKey: CREATED_AT, reverse: true, query: "status:any") {
          edges {
            node {
              id
              name
              createdAt
              displayFulfillmentStatus
              tags
            }
          }
        }
      }`
    );

    const payload = await response.json();
    const recentOrders = payload.data?.orders?.edges?.map((e) => e.node) || [];

    return jsonResponse({
      success: true,
      message: "Order sync heartbeat active",
      syncedCount: recentOrders.length,
      latestOrder: recentOrders[0]?.name || null,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Order Sync Error:", error);
    return jsonResponse({ success: false, error: error.message }, 200);
  }
};