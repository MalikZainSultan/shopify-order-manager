import React, { useMemo, useState, useCallback } from "react";
import { useLoaderData } from "react-router";
import {
  Page,
  Layout,
  Card,
  Tabs,
  IndexTable,
  Badge,
  Filters,
  ChoiceList,
  Button,
  Text,
  BlockStack,
  InlineStack,
  Box,
  Icon,
  Banner,
  EmptyState,
  Divider,
  Tooltip,
  AppProvider as PolarisProvider,
} from "@shopify/polaris";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  AlertTriangleIcon,
  PackageIcon,
  CheckCircleIcon,
  XIcon,
  SearchIcon,
  CalendarIcon,
} from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";

const jsonResponse = (data) => {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};

/* ------------------------------------------------------------------ */
/*  1. UNLIMITED GRAPHQL FETCHING ENGINE (ALL ORDERS, NO LIMIT)       */
/* ------------------------------------------------------------------ */

const ALL_ORDERS_QUERY = `#graphql
  query FetchReleaseQueue($cursor: String) {
    orders(
      first: 50
      after: $cursor
      sortKey: CREATED_AT
      reverse: true
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
            firstName
            lastName
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

async function fetchAllOrders(admin) {
  const orders = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    try {
      const response = await admin.graphql(ALL_ORDERS_QUERY, {
        variables: { cursor },
      });
      const payload = await response.json();

      if (payload.errors) {
        console.error("GraphQL Execution Errors:", JSON.stringify(payload.errors, null, 2));
        break;
      }

      const ordersConnection = payload.data?.orders;
      if (ordersConnection?.edges) {
        orders.push(...ordersConnection.edges.map((edge) => edge.node));
      }

      hasNextPage = ordersConnection?.pageInfo?.hasNextPage || false;
      cursor = ordersConnection?.pageInfo?.endCursor || null;
    } catch (err) {
      console.error("Pipeline Fetch Error:", err);
      break;
    }
  }

  return orders;
}

/* ------------------------------------------------------------------ */
/*  2. DATA PROCESSING & GROUPING RUNTIME                             */
/* ------------------------------------------------------------------ */

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysBetween(later, earlier) {
  return Math.floor((later.getTime() - earlier.getTime()) / MS_PER_DAY);
}

function extractFocDate(productTags = [], productFocMetafield = null) {
  if (productFocMetafield) return productFocMetafield;
  
  const tagList = Array.isArray(productTags) ? productTags : [];
  const focTag = tagList.find((t) => t.toLowerCase().startsWith("foc-"));
  if (focTag) {
    const rawDate = focTag.substring(4).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      return rawDate;
    }
  }
  return null;
}

function detectChannel(order) {
  const tagList = Array.isArray(order.tags) ? order.tags.map((t) => t.toLowerCase()) : [];
  if (tagList.some((t) => t.includes("ebay"))) return "ebay";
  if (tagList.some((t) => t.includes("whatnot"))) return "whatnot";
  return "shopify";
}

function buildCustomerKey(order) {
  const c = order.customer;
  const email = order.email;
  const a = order.shippingAddress;
  const key = [c?.firstName, c?.lastName, email, a?.address1, a?.zip]
    .map((part) => (part || "").toString().trim().toLowerCase())
    .join("|");
  return key.replace(/\|+/g, "|") === "|" ? `guest-${order.id}` : key;
}

function processOrder(rawOrder, today) {
  if (!rawOrder.lineItems?.edges) return null;

  const allRawItems = rawOrder.lineItems.edges.map((edge) => edge.node);
  if (allRawItems.length === 0) return null;

  const isCancelled = Boolean(rawOrder.cancelledAt);

  const isFullyFulfilled =
    rawOrder.displayFulfillmentStatus === "FULFILLED" ||
    allRawItems.every((li) => li.unfulfilledQuantity === 0);

  const lineItems = allRawItems.map((li) => {
    const releaseDateRaw = li.product?.metafield?.value || null;
    const releaseDate = releaseDateRaw ? new Date(releaseDateRaw) : null;
    const isReleased = !releaseDate || releaseDate <= today;

    const focDateRaw = extractFocDate(li.product?.tags, li.product?.focMetafield?.value);

    let daysPastRelease = null;
    let agingStatus = null;

    if (isReleased && releaseDate && li.unfulfilledQuantity > 0 && !isCancelled) {
      daysPastRelease = daysBetween(today, releaseDate);
      if (daysPastRelease >= 14) agingStatus = "critical";
      else if (daysPastRelease >= 7) agingStatus = "warning";
    }

    return {
      id: li.id,
      title: li.title,
      variantTitle: li.variantTitle,
      quantity: li.quantity,
      unfulfilledQuantity: li.unfulfilledQuantity,
      productId: li.product?.id || null,
      releaseDate: releaseDateRaw,
      focDate: focDateRaw,
      isReleased,
      daysPastRelease,
      agingStatus,
    };
  });

  const hasUnfulfilled = lineItems.some((li) => li.unfulfilledQuantity > 0) && !isCancelled;

  let bucket;
  if (isCancelled) {
    bucket = "cancelled";
  } else if (isFullyFulfilled) {
    bucket = "completed";
  } else {
    const activeUnfulfilledItems = lineItems.filter((li) => li.unfulfilledQuantity > 0);
    const allReleased = activeUnfulfilledItems.every((li) => li.isReleased);
    const noneReleased = activeUnfulfilledItems.every((li) => !li.isReleased);

    if (allReleased) bucket = "readyToShip";
    else if (noneReleased) bucket = "waitingOnRelease";
    else bucket = "partiallyReady";
  }

  return {
    id: rawOrder.id,
    name: rawOrder.name,
    createdAt: rawOrder.createdAt,
    cancelledAt: rawOrder.cancelledAt,
    cancelReason: rawOrder.cancelReason,
    sourceName: detectChannel(rawOrder),
    tags: rawOrder.tags || [],
    customer: rawOrder.customer,
    email: rawOrder.email,
    shippingAddress: rawOrder.shippingAddress,
    lineItems,
    bucket,
    hasUnfulfilled,
    isCancelled,
    customerKey: buildCustomerKey(rawOrder),
  };
}

function groupByCustomer(orders) {
  const map = new Map();
  for (const order of orders) {
    if (!map.has(order.customerKey)) map.set(order.customerKey, []);
    map.get(order.customerKey).push(order);
  }

  return Array.from(map.values())
    .map((groupOrders) => {
      const first = groupOrders[0];
      const customerName =
        `${first.customer?.firstName || ""} ${first.customer?.lastName || ""}`.trim() ||
        first.shippingAddress?.name ||
        "Unknown Buyer";
      return {
        key: first.customerKey,
        customerName,
        customerEmail: first.email || "—",
        shippingAddress: first.shippingAddress,
        orders: groupOrders,
        isMultiOrder: groupOrders.length > 1,
        worstAging: groupOrders.reduce((worst, o) => {
          const orderWorst = o.lineItems.reduce((w, li) => {
            if (li.agingStatus === "critical") return "critical";
            if (li.agingStatus === "warning" && w !== "critical") return "warning";
            return w;
          }, null);
          if (orderWorst === "critical") return "critical";
          if (orderWorst === "warning" && worst !== "critical") return "warning";
          return worst;
        }, null),
      };
    })
    .sort((a, b) => {
      if (a.isMultiOrder !== b.isMultiOrder) return a.isMultiOrder ? -1 : 1;
      const rank = { critical: 0, warning: 1, null: 2 };
      return rank[a.worstAging] - rank[b.worstAging];
    });
}

function buildFocPullList(waitingOrders) {
  const focMap = new Map();

  for (const order of waitingOrders) {
    for (const item of order.lineItems) {
      if (item.unfulfilledQuantity > 0 && !item.isReleased) {
        const focKey = item.focDate || "No FOC Date Assigned";
        if (!focMap.has(focKey)) {
          focMap.set(focKey, new Map());
        }

        const dateGroup = focMap.get(focKey);
        const itemKey = `${item.title}-${item.variantTitle || ""}`;

        if (!dateGroup.has(itemKey)) {
          dateGroup.set(itemKey, {
            title: item.title,
            variantTitle: item.variantTitle,
            quantity: 0,
            releaseDate: item.releaseDate,
            focDate: item.focDate,
            orders: [],
          });
        }

        const existing = dateGroup.get(itemKey);
        existing.quantity += item.unfulfilledQuantity;
        existing.orders.push({
          orderName: order.name,
          sourceName: order.sourceName,
          customer: `${order.customer?.firstName || ""} ${order.customer?.lastName || ""}`.trim() || "Buyer",
        });
      }
    }
  }

  return Array.from(focMap.entries())
    .map(([focDate, itemsMap]) => ({
      focDate,
      items: Array.from(itemsMap.values()),
    }))
    .sort((a, b) => {
      if (a.focDate === "No FOC Date Assigned") return 1;
      if (b.focDate === "No FOC Date Assigned") return -1;
      return new Date(a.focDate) - new Date(b.focDate);
    });
}

function processOrders(rawOrders) {
  const today = startOfToday();
  const buckets = {
    allUnfulfilled: [],
    readyToShip: [],
    partiallyReady: [],
    waitingOnRelease: [],
    completed: [],
    cancelled: [],
  };
  const pullListItems = [];
  const allOrdersList = [];

  for (const rawOrder of rawOrders) {
    const processed = processOrder(rawOrder, today);
    if (!processed) continue;

    allOrdersList.push(processed);

    if (processed.hasUnfulfilled) {
      buckets.allUnfulfilled.push(processed);
    }

    buckets[processed.bucket].push(processed);

    if (processed.bucket === "partiallyReady") {
      processed.lineItems
        .filter((li) => li.isReleased && li.unfulfilledQuantity > 0)
        .forEach((li) => {
          pullListItems.push({
            orderId: processed.id,
            orderName: processed.name,
            sourceName: processed.sourceName,
            customerName:
              `${processed.customer?.firstName || ""} ${processed.customer?.lastName || ""}`.trim() ||
              processed.shippingAddress?.name ||
              "Unknown",
            ...li,
          });
        });
    }
  }

  const focPullList = buildFocPullList(buckets.waitingOnRelease);

  return {
    allOrdersGrouped: groupByCustomer(allOrdersList),
    groups: {
      allUnfulfilled: groupByCustomer(buckets.allUnfulfilled),
      readyToShip: groupByCustomer(buckets.readyToShip),
      partiallyReady: groupByCustomer(buckets.partiallyReady),
      waitingOnRelease: groupByCustomer(buckets.waitingOnRelease),
      completed: groupByCustomer(buckets.completed),
      cancelled: groupByCustomer(buckets.cancelled),
    },
    counts: {
      allUnfulfilled: buckets.allUnfulfilled.length,
      readyToShip: buckets.readyToShip.length,
      partiallyReady: buckets.partiallyReady.length,
      waitingOnRelease: buckets.waitingOnRelease.length,
      completed: buckets.completed.length,
      cancelled: buckets.cancelled.length,
    },
    pullListItems: pullListItems.sort((a, b) => (b.daysPastRelease || 0) - (a.daysPastRelease || 0)),
    focPullList,
  };
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const rawOrders = await fetchAllOrders(admin);
  const { allOrdersGrouped, groups, counts, pullListItems, focPullList } = processOrders(rawOrders);

  return jsonResponse({
    allOrdersGrouped,
    groups,
    counts,
    pullListItems,
    focPullList,
    fetchedAt: new Date().toISOString(),
  });
};

/* ------------------------------------------------------------------ */
/*  3. USER INTERFACE COMPONENTS                                      */
/* ------------------------------------------------------------------ */

const CHANNEL_OPTIONS = [
  { label: "Shopify Native", value: "shopify" },
  { label: "eBay Marketplace", value: "ebay" },
  { label: "Whatnot Live", value: "whatnot" },
];

function formatDate(dateString) {
  if (!dateString) return "—";
  return new Date(dateString).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function ChannelBadge({ sourceName }) {
  const map = {
    shopify: { tone: "success", label: "Shopify" },
    ebay: { tone: "info", label: "eBay" },
    whatnot: { tone: "attention", label: "Whatnot" },
  };
  const entry = map[sourceName] || { tone: undefined, label: sourceName };
  return <Badge tone={entry.tone}>{entry.label}</Badge>;
}

function AgingBadge({ agingStatus }) {
  if (agingStatus === "critical") {
    return <Badge tone="critical" icon={AlertTriangleIcon}>2+ Wks Late Escalation</Badge>;
  }
  if (agingStatus === "warning") {
    return <Badge tone="warning" icon={AlertTriangleIcon}>1+ Wk Late Aging Flag</Badge>;
  }
  return null;
}

function BucketBadge({ bucketKey }) {
  const map = {
    allUnfulfilled: { tone: "attention", label: "All Unfulfilled Queue" },
    readyToShip: { tone: "success", label: "Ready to Ship" },
    partiallyReady: { tone: "attention", label: "Partially Ready" },
    waitingOnRelease: { tone: "info", label: "Waiting on Release" },
    completed: { tone: "complete", label: "Shipped & Completed" },
    cancelled: { tone: "critical", label: "Cancelled Orders" },
  };
  const entry = map[bucketKey];
  return <Badge tone={entry?.tone}>{entry?.label}</Badge>;
}

function filterGroupsByChannel(groups, selectedChannels) {
  if (!selectedChannels || selectedChannels.length === 0) return groups;
  return groups
    .map((group) => {
      const matchingOrders = group.orders.filter((o) => selectedChannels.includes(o.sourceName));
      if (matchingOrders.length === 0) return null;
      return { ...group, orders: matchingOrders };
    })
    .filter(Boolean);
}

function filterGroupsByQuery(groups, query) {
  if (!query) return groups;
  const q = query.trim().toLowerCase();
  return groups.filter((group) => {
    return (
      group.customerName.toLowerCase().includes(q) ||
      group.customerEmail.toLowerCase().includes(q) ||
      group.orders.some((o) => o.name.toLowerCase().includes(q))
    );
  });
}

function OrderSummaryRow({ order, indented }) {
  const itemCount = order.lineItems.reduce((sum, li) => sum + li.quantity, 0);
  const worstAging = order.lineItems.reduce((worst, li) => {
    if (li.agingStatus === "critical") return "critical";
    if (li.agingStatus === "warning" && worst !== "critical") return "warning";
    return worst;
  }, null);

  return (
    <Box paddingInlineStart={indented ? "800" : "0"} paddingBlock="200">
      <InlineStack align="space-between" blockAlign="center">
        <InlineStack gap="300" blockAlign="center">
          <Text as="span" fontWeight="semibold">{order.name}</Text>
          <ChannelBadge sourceName={order.sourceName} />
          <Text as="span" tone="subdued">Placed: {formatDate(order.createdAt)}</Text>
          {order.isCancelled && (
            <Badge tone="critical" icon={XIcon}>
              Cancelled ({formatDate(order.cancelledAt)})
            </Badge>
          )}
          <Text as="span" tone="subdued">{itemCount} Item(s)</Text>
        </InlineStack>
        <AgingBadge agingStatus={worstAging} />
      </InlineStack>
      <Box paddingBlockStart="150">
        <BlockStack gap="100">
          {order.lineItems.map((li) => (
            <InlineStack key={li.id} align="space-between">
              <Text as="span" tone="subdued">
                {li.unfulfilledQuantity} of {li.quantity}x {li.title} {li.variantTitle ? ` — ${li.variantTitle}` : ""}
              </Text>
              <InlineStack gap="200">
                {li.focDate && <Badge tone="info">FOC: {li.focDate}</Badge>}
                <Text as="span" tone="subdued">
                  Release Status: {formatDate(li.releaseDate) === "—" ? "Immediate" : formatDate(li.releaseDate)}
                </Text>
                {order.isCancelled ? (
                  <Badge tone="critical">Voided</Badge>
                ) : (
                  <>
                    {!li.isReleased && <Badge tone="info">Future Pre-order</Badge>}
                    {li.unfulfilledQuantity === 0 && <Badge tone="success" icon={CheckCircleIcon}>Shipped</Badge>}
                    {li.unfulfilledQuantity > 0 && li.isReleased && <Badge tone="attention">Pending Pickup</Badge>}
                  </>
                )}
                <AgingBadge agingStatus={li.agingStatus} />
              </InlineStack>
            </InlineStack>
          ))}
        </BlockStack>
      </Box>
    </Box>
  );
}

function BucketIndexTable({ groups, bucketKey, expandedGroups, onToggleGroup }) {
  if (groups.length === 0) {
    return (
      <Box paddingBlock="800">
        <EmptyState
          heading="Queue Cleared / No Matching Results"
          image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
        >
          <p>No matching order records found across the database query criteria.</p>
        </EmptyState>
      </Box>
    );
  }

  return (
    <BlockStack gap="0">
      <IndexTable
        resourceName={{ singular: "shipment block", plural: "shipment blocks" }}
        itemCount={groups.length}
        selectable={false}
        headings={[
          { title: "" },
          { title: "Pack Destination" },
          { title: "Pending Orders" },
          { title: "Delivery Destination" },
          { title: "Marketplace Track" },
          { title: "Aging / Status" },
        ]}
      >
        {groups.map((group, index) => {
          const isExpanded = expandedGroups.has(group.key);
          const primaryOrder = group.orders[0];

          return (
            <React.Fragment key={group.key}>
              <IndexTable.Row id={group.key} key={group.key} position={index} tone={group.isMultiOrder ? "subdued" : undefined}>
                <IndexTable.Cell>
                  <Button
                    variant="tertiary"
                    icon={isExpanded ? ChevronUpIcon : ChevronDownIcon}
                    onClick={() => onToggleGroup(group.key)}
                  />
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <BlockStack gap="0">
                    <Text as="span" fontWeight="semibold">{group.customerName}</Text>
                    <Text as="span" tone="subdued">{group.customerEmail}</Text>
                  </BlockStack>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  {group.isMultiOrder ? (
                    <Badge tone="attention">{`${group.orders.length} Combined Separate Orders`}</Badge>
                  ) : (
                    <Text as="span">{primaryOrder?.name}</Text>
                  )}
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Text as="span">{group.shippingAddress?.address1}{group.shippingAddress?.city ? `, ${group.shippingAddress.city}` : ""}</Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <InlineStack gap="150">
                    {Array.from(new Set(group.orders.map((o) => o.sourceName))).map((src) => (
                      <ChannelBadge key={src} sourceName={src} />
                    ))}
                  </InlineStack>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  {bucketKey === "cancelled" ? (
                    <Badge tone="critical">Cancelled</Badge>
                  ) : (
                    <AgingBadge agingStatus={group.worstAging} />
                  )}
                </IndexTable.Cell>
              </IndexTable.Row>

              {isExpanded && (
                <tr style={{ backgroundColor: "var(--p-color-bg-surface-secondary)" }}>
                  <td colSpan={6} style={{ padding: "12px 24px" }}>
                    <Box padding="400">
                      <BlockStack gap="300">
                        <Text as="h4" fontWeight="bold" tone="subdued">
                          Consolidated Shipping Matrix Elements:
                        </Text>
                        {group.orders.map((order, i) => (
                          <Box key={order.id}>
                            <OrderSummaryRow order={order} indented={false} />
                            {i < group.orders.length - 1 && <Divider />}
                          </Box>
                        ))}
                      </BlockStack>
                    </Box>
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        })}
      </IndexTable>
    </BlockStack>
  );
}

function PullListTable({ items }) {
  if (items.length === 0) {
    return <Banner tone="success">Harvest Complete — All partial items cleared.</Banner>;
  }

  return (
    <IndexTable
      resourceName={{ singular: "item", plural: "items" }}
      itemCount={items.length}
      selectable={false}
      headings={[
        { title: "Physical Product Component" },
        { title: "Order ID" },
        { title: "Consignee" },
        { title: "Marketplace Source" },
        { title: "Release Target Date" },
        { title: "Aging Index" },
      ]}
    >
      {items.map((item, index) => (
        <IndexTable.Row id={`${item.orderId}-${item.id}`} key={`${item.orderId}-${item.id}`} position={index}>
          <IndexTable.Cell>
            <Text as="span" fontWeight="semibold">{item.unfulfilledQuantity}x {item.title}</Text>
            {item.variantTitle && <Text as="span" tone="subdued"> — {item.variantTitle}</Text>}
          </IndexTable.Cell>
          <IndexTable.Cell>{item.orderName}</IndexTable.Cell>
          <IndexTable.Cell>{item.customerName}</IndexTable.Cell>
          <IndexTable.Cell><ChannelBadge sourceName={item.sourceName} /></IndexTable.Cell>
          <IndexTable.Cell>{formatDate(item.releaseDate)}</IndexTable.Cell>
          <IndexTable.Cell><AgingBadge agingStatus={item.agingStatus} /></IndexTable.Cell>
        </IndexTable.Row>
      ))}
    </IndexTable>
  );
}

function FocPullListView({ focGroups }) {
  if (!focGroups || focGroups.length === 0) {
    return <Banner tone="info">No future FOC pre-order items pending order placement.</Banner>;
  }

  return (
    <BlockStack gap="400">
      {focGroups.map((group) => (
        <Card key={group.focDate} padding="400">
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <InlineStack gap="200" blockAlign="center">
                <Icon source={CalendarIcon} tone="base" />
                <Text as="h3" variant="headingMd" fontWeight="bold">
                  FOC Order Deadline: {group.focDate === "No FOC Date Assigned" ? "Unassigned FOC" : formatDate(group.focDate)}
                </Text>
              </InlineStack>
              <Badge tone="attention">{`${group.items.reduce((s, i) => s + i.quantity, 0)} Total Units to Order`}</Badge>
            </InlineStack>

            <IndexTable
              resourceName={{ singular: "FOC item", plural: "FOC items" }}
              itemCount={group.items.length}
              selectable={false}
              headings={[
                { title: "Physical Product Component (Quantity Needed)" },
                { title: "Release Date" },
                { title: "Order References" },
              ]}
            >
              {group.items.map((item, idx) => (
                <IndexTable.Row id={`${group.focDate}-${idx}`} key={`${group.focDate}-${idx}`} position={idx}>
                  <IndexTable.Cell>
                    <Text as="span" fontWeight="bold">{item.quantity}x </Text>
                    <Text as="span" fontWeight="semibold">{item.title}</Text>
                    {item.variantTitle && <Text as="span" tone="subdued"> — {item.variantTitle}</Text>}
                  </IndexTable.Cell>
                  <IndexTable.Cell>{formatDate(item.releaseDate)}</IndexTable.Cell>
                  <IndexTable.Cell>
                    <InlineStack gap="100">
                      {item.orders.map((o, oIdx) => (
                        <Tooltip key={oIdx} content={`${o.customer} (${o.sourceName})`}>
                          <Badge tone="info">{o.orderName}</Badge>
                        </Tooltip>
                      ))}
                    </InlineStack>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </BlockStack>
        </Card>
      ))}
    </BlockStack>
  );
}

export default function FulfillmentDashboard() {
  const { allOrdersGrouped, groups, counts, pullListItems, focPullList, fetchedAt } = useLoaderData();

  const [selectedTab, setSelectedTab] = useState(0);
  const [channelFilter, setChannelFilter] = useState([]);
  const [queryValue, setQueryValue] = useState("");
  const [expandedGroups, setExpandedGroups] = useState(new Set());

  const onToggleGroup = useCallback((key) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const tabs = [
    { id: "all-unfulfilled", content: "Unfulfilled Orders", badgeCount: counts.allUnfulfilled, bucketKey: "allUnfulfilled" },
    { id: "ready-to-ship", content: "Ready to Ship", badgeCount: counts.readyToShip, bucketKey: "readyToShip" },
    { id: "partially-ready", content: "Partially Ready", badgeCount: counts.partiallyReady, bucketKey: "partiallyReady" },
    { id: "waiting-on-release", content: "Waiting on Release", badgeCount: counts.waitingOnRelease, bucketKey: "waitingOnRelease" },
    { id: "completed-shipped", content: "Completed / Shipped", badgeCount: counts.completed, bucketKey: "completed" },
    { id: "cancelled-orders", content: "Cancelled Orders", badgeCount: counts.cancelled, bucketKey: "cancelled" },
  ];

  const activeBucketKey = tabs[selectedTab].bucketKey;

  const filteredGroups = useMemo(() => {
    const isSearching = Boolean(queryValue.trim());
    const base = isSearching ? allOrdersGrouped : (groups[activeBucketKey] || []);
    const byChannel = filterGroupsByChannel(base, channelFilter);
    return filterGroupsByQuery(byChannel, queryValue);
  }, [groups, allOrdersGrouped, activeBucketKey, channelFilter, queryValue]);

  const filteredPullListItems = useMemo(() => {
    if (channelFilter.length === 0) return pullListItems;
    return pullListItems.filter((item) => channelFilter.includes(item.sourceName));
  }, [pullListItems, channelFilter]);

  const appliedFilters = channelFilter.length > 0 ? [{
    key: "channel",
    label: `Channel Filters: ${channelFilter.map((c) => CHANNEL_OPTIONS.find((o) => o.value === c)?.label).join(", ")}`,
    onRemove: () => setChannelFilter([]),
  }] : [];

  return (
    <PolarisProvider i18n={{}}>
      <style>{`
        .Polaris-Page {
          max-width: 100% !important;
          margin: 0 auto;
        }
      `}</style>

      <Page
        title="Release Date Automated Dispatch Board"
        subtitle="Metafield Synchronization Queue Engine (Zero Manual Tagging Active)"
      >
        <Layout>
          <Layout.Section>
            <Card padding="0">
              <Tabs
                tabs={tabs.map((tab) => ({ id: tab.id, content: `${tab.content} (${tab.badgeCount})` }))}
                selected={selectedTab}
                onSelect={setSelectedTab}
              />
              <Box padding="400">
                <BlockStack gap="400">
                  <Filters
                    queryValue={queryValue}
                    queryPlaceholder="Global Search: Type Order # or Customer Name across ALL tabs..."
                    onQueryChange={setQueryValue}
                    onQueryClear={() => setQueryValue("")}
                    onClearAll={() => { setQueryValue(""); setChannelFilter([]); }}
                    filters={[{
                      key: "channel",
                      label: "Marketplace Channels",
                      filter: (
                        <ChoiceList
                          title="Sales channel"
                          titleHidden
                          choices={CHANNEL_OPTIONS}
                          selected={channelFilter}
                          onChange={setChannelFilter}
                          allowMultiple
                        />
                      ),
                    }]}
                    appliedFilters={appliedFilters}
                  />

                  {queryValue.trim() && (
                    <Banner tone="info" icon={SearchIcon}>
                      <Text as="p" fontWeight="bold">
                        Global Search Active: Showing results matching "{queryValue}" across ALL tabs and status categories.
                      </Text>
                    </Banner>
                  )}

                  {selectedTab === 2 && !queryValue.trim() && (
                    <Banner tone="warning" icon={PackageIcon}>
                      <Text as="p" fontWeight="semibold">Warehouse Extract / Harvest Pull List</Text>
                      <Text as="p">Extract these line items from storage racks immediately. They are physically released but bound inside composite pre-order allocations.</Text>
                      <Box paddingBlockStart="300">
                        <PullListTable items={filteredPullListItems} />
                      </Box>
                    </Banner>
                  )}

                  {selectedTab === 3 && !queryValue.trim() && (
                    <BlockStack gap="300">
                      <Banner tone="info" icon={CalendarIcon}>
                        <Text as="p" fontWeight="semibold">FOC Weekly Ordering Pull List</Text>
                        <Text as="p">All unreleased items grouped by their FOC (Final Order Cutoff) deadline for vendor order placement.</Text>
                      </Banner>
                      <FocPullListView focGroups={focPullList} />
                    </BlockStack>
                  )}

                  <BucketIndexTable
                    groups={filteredGroups}
                    bucketKey={activeBucketKey}
                    expandedGroups={expandedGroups}
                    onToggleGroup={onToggleGroup}
                  />
                </BlockStack>
              </Box>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Icon source={PackageIcon} tone="base" />
                  <Text as="h3" fontWeight="semibold">Realtime Fulfillment Metrics</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <BucketBadge bucketKey="allUnfulfilled" />
                  <Text as="span">{counts.allUnfulfilled} Total Pending</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <BucketBadge bucketKey="readyToShip" />
                  <Text as="span">{counts.readyToShip} Orders Pending</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <BucketBadge bucketKey="partiallyReady" />
                  <Text as="span">{counts.partiallyReady} Hybrid Units</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <BucketBadge bucketKey="waitingOnRelease" />
                  <Text as="span">{counts.waitingOnRelease} Vaulted Holds</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <BucketBadge bucketKey="completed" />
                  <Text as="span">{counts.completed} Shipped Orders</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <BucketBadge bucketKey="cancelled" />
                  <Text as="span">{counts.cancelled} Cancelled Orders</Text>
                </InlineStack>
                <Divider />
                <Tooltip content="Live query architecture fetches directly from admin datastore.">
                  <Text as="span" tone="subdued">Last Sync Cycle: {new Date(fetchedAt).toLocaleTimeString()}</Text>
                </Tooltip>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    </PolarisProvider>
  );
}