import React, { useMemo, useState, useCallback, useEffect } from "react";
import { useLoaderData, useFetcher } from "react-router";
import {
  AppProvider,
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
  Pagination,
} from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  AlertTriangleIcon,
  PackageIcon,
  CheckCircleIcon,
  XIcon,
  SearchIcon,
  CalendarIcon,
  ClockIcon,
  RefreshIcon,
} from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";

const jsonResponse = (data) => {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};

/* ------------------------------------------------------------------ */
/*  1. BULK GRAPHQL FETCHING (BOTH ACTIVE & FULFILLED ORDERS)         */
/* ------------------------------------------------------------------ */

const ORDERS_BATCH_QUERY = `#graphql
  query FetchOrdersBatch($cursor: String, $queryStr: String) {
    orders(
      first: 100
      after: $cursor
      sortKey: CREATED_AT
      reverse: true
      query: $queryStr
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchAllStoreOrdersUnlimited(admin) {
  const allOrders = [];
  const seenIds = new Set();

  async function fetchBatches(queryFilter, maxBatches) {
    let cursor = null;
    let hasNextPage = true;
    let count = 0;

    while (hasNextPage && count < maxBatches) {
      count++;
      try {
        const response = await admin.graphql(ORDERS_BATCH_QUERY, {
          variables: { cursor, queryStr: queryFilter },
        });

        if (response.status === 429) {
          await delay(1200);
          continue;
        }

        const payload = await response.json();
        const ordersData = payload.data?.orders;
        if (!ordersData?.edges || ordersData.edges.length === 0) break;

        for (const edge of ordersData.edges) {
          if (!seenIds.has(edge.node.id)) {
            seenIds.add(edge.node.id);
            allOrders.push(edge.node);
          }
        }

        hasNextPage = Boolean(ordersData.pageInfo?.hasNextPage);
        cursor = ordersData.pageInfo?.endCursor || null;
        await delay(50);
      } catch (err) {
        console.error("Batch Fetch Exception:", err);
        break;
      }
    }
  }

  // Pehle Jim Adams ke bataye hue target orders ko direct grab karein
  try {
    const directTargetQuery = "name:#4527 OR name:#5078 OR name:#5199 OR name:#5211 OR name:#5413 OR 4527 OR 5078 OR 5199 OR 5211 OR 5413";
    const directRes = await admin.graphql(ORDERS_BATCH_QUERY, {
      variables: { cursor: null, queryStr: directTargetQuery },
    });
    const directPayload = await directRes.json();
    const directEdges = directPayload.data?.orders?.edges || [];
    for (const edge of directEdges) {
      if (!seenIds.has(edge.node.id)) {
        seenIds.add(edge.node.id);
        allOrders.push(edge.node);
      }
    }
  } catch (err) {
    console.error("Target Fetch Error:", err);
  }

  // Store ke saare active orders
  await fetchBatches("status:open", 20);

  // Store ke saare fulfilled/closed orders
  await fetchBatches("status:closed", 20);

  return allOrders;
}

/* ------------------------------------------------------------------ */
/*  2. US TIMEZONE & DATA PROCESSING ENGINE                           */
/* ------------------------------------------------------------------ */

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function startOfTodayInUS(timeZone = "America/New_York") {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const mm = parts.find((p) => p.type === "month")?.value;
  const dd = parts.find((p) => p.type === "day")?.value;
  const yyyy = parts.find((p) => p.type === "year")?.value;

  return new Date(Number(yyyy), Number(mm) - 1, Number(dd), 0, 0, 0, 0);
}

function parseSafeDate(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const cleanStr = dateStr.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(cleanStr)) {
    const [y, m, d] = cleanStr.split("-").map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  }

  if (/^\d{2}\/\d{2}\/\d{4}$/.test(cleanStr)) {
    const [m, d, y] = cleanStr.split("/").map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  }

  const parsed = new Date(cleanStr);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function daysBetween(later, earlier) {
  return Math.floor((later.getTime() - earlier.getTime()) / MS_PER_DAY);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function extractFocDate(productTags = [], productFocMetafield = null) {
  if (productFocMetafield) return productFocMetafield;
  const tagList = Array.isArray(productTags) ? productTags : [];
  const focTag = tagList.find((t) => t && t.toLowerCase().startsWith("foc-"));
  if (focTag) {
    const rawDate = focTag.substring(4).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      return rawDate;
    }
  }
  return null;
}

function detectChannel(order) {
  const tagList = Array.isArray(order.tags) ? order.tags.map((t) => (t || "").toLowerCase()) : [];
  const orderName = (order.name || "").toLowerCase();

  const hasEbayTag = tagList.some((t) => t.includes("ebay") || t.includes("cedcommerce"));
  const isEbayOrderNumber = orderName.includes("ebay") || /^\d{2}-\d{5}-\d{5}/.test(order.name ? order.name.trim() : "");

  if (hasEbayTag || isEbayOrderNumber) {
    return "ebay";
  }

  if (tagList.some((t) => t.includes("whatnot"))) return "whatnot";
  return "shopify";
}

function isCgcItem(item) {
  const title = (item.title || "").toLowerCase();
  const sku = (item.sku || "").toLowerCase();
  const variantTitle = (item.variantTitle || "").toLowerCase();
  return title.includes("cgc") || sku.includes("cgc") || variantTitle.includes("cgc");
}

function hasCgcRemovalTag(orderTags = [], lineItemId = null) {
  const tags = Array.isArray(orderTags) ? orderTags.map((t) => (t || "").toLowerCase().trim()) : [];
  const validTags = ["cgc-returned", "cgc-processed", "cgc-done", "cgc-received"];

  if (tags.some((t) => validTags.includes(t))) return true;
  if (lineItemId && tags.some((t) => t === `cgc-returned-${lineItemId}`.toLowerCase())) return true;

  return false;
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
  const allRawItems = rawOrder.lineItems?.edges ? rawOrder.lineItems.edges.map((edge) => edge.node) : [];

  const isCancelled = Boolean(rawOrder.cancelledAt);
  const isFullyFulfilled =
    rawOrder.displayFulfillmentStatus === "FULFILLED" ||
    (allRawItems.length > 0 && allRawItems.every((li) => li.unfulfilledQuantity === 0));

  const orderHasCgcRemovalTag = hasCgcRemovalTag(rawOrder.tags);

  const lineItems = allRawItems.map((li) => {
    const releaseDateRaw = li.product?.metafield?.value || null;
    const releaseDate = parseSafeDate(releaseDateRaw);

    const isReleased = !releaseDate || releaseDate.getTime() <= today.getTime();

    const focDateRaw = extractFocDate(li.product?.tags, li.product?.focMetafield?.value);
    const isCgc = isCgcItem(li);
    const isReturned = orderHasCgcRemovalTag || hasCgcRemovalTag(rawOrder.tags, li.id);

    const isAtGrading = isCgc && !isReturned;

    let estimatedGradingReadyDate = null;
    let daysPastGradingEstimate = null;

    if (isCgc) {
      const baseDate = releaseDate || new Date(rawOrder.createdAt);
      estimatedGradingReadyDate = addDays(baseDate, 90);
      if (today.getTime() > estimatedGradingReadyDate.getTime() && !isReturned) {
        daysPastGradingEstimate = daysBetween(today, estimatedGradingReadyDate);
      }
    }

    let daysPastRelease = null;
    let agingStatus = null;

    if (li.unfulfilledQuantity > 0 && !isCancelled) {
      if (isAtGrading) {
        if (daysPastGradingEstimate && daysPastGradingEstimate > 0) {
          agingStatus = "critical";
        }
      } else if (isReleased && releaseDate) {
        daysPastRelease = daysBetween(today, releaseDate);
        if (daysPastRelease >= 14) agingStatus = "critical";
        else if (daysPastRelease >= 7) agingStatus = "warning";
      }
    }

    return {
      id: li.id,
      title: li.title,
      variantTitle: li.variantTitle,
      sku: li.sku || "",
      quantity: li.quantity,
      unfulfilledQuantity: li.unfulfilledQuantity,
      productId: li.product?.id || null,
      releaseDate: releaseDateRaw,
      focDate: focDateRaw,
      isReleased,
      isCgc,
      isAtGrading,
      isGradingReturned: isReturned,
      estimatedGradingReadyDate: estimatedGradingReadyDate ? estimatedGradingReadyDate.toISOString() : null,
      daysPastGradingEstimate,
      daysPastRelease,
      agingStatus,
    };
  });

  const hasUnfulfilled = lineItems.some((li) => li.unfulfilledQuantity > 0) && !isCancelled;
  const hasCgcItemInOrder = lineItems.some((li) => li.isCgc);
  const cgcActiveInOrder = hasCgcItemInOrder && !orderHasCgcRemovalTag && !isFullyFulfilled && !isCancelled;

  let bucket;
  if (isCancelled) {
    bucket = "cancelled";
  } else if (isFullyFulfilled) {
    bucket = "completed";
  } else {
    const activeItems = lineItems.filter((li) => li.unfulfilledQuantity > 0);
    const allAtGrading = activeItems.length > 0 && activeItems.every((li) => li.isAtGrading);
    const allPreOrder = activeItems.length > 0 && activeItems.every((li) => !li.isReleased && !li.isAtGrading);
    const allReadyToShip =
      activeItems.length === 0 ||
      activeItems.every((li) => (li.isReleased && !li.isAtGrading) || (li.isCgc && li.isGradingReturned));

    if (allReadyToShip) {
      bucket = "readyToShip";
    } else if (allAtGrading) {
      bucket = "atGrading";
    } else if (allPreOrder) {
      bucket = "waitingOnRelease";
    } else {
      bucket = "partiallyReady";
    }
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
    cgcActiveInOrder,
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
            if (li.agingStatus === "warning" && worst !== "critical") return "warning";
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
      if (item.unfulfilledQuantity > 0 && !item.isReleased && !item.isAtGrading) {
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
  const today = startOfTodayInUS();
  const buckets = {
    allUnfulfilled: [],
    readyToShip: [],
    atGrading: [],
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

    if (processed.hasUnfulfilled) buckets.allUnfulfilled.push(processed);
    if (buckets[processed.bucket]) buckets[processed.bucket].push(processed);

    if (processed.cgcActiveInOrder) {
      if (!buckets.atGrading.some((o) => o.id === processed.id)) {
        buckets.atGrading.push(processed);
      }
    }

    if (processed.bucket === "partiallyReady") {
      processed.lineItems
        .filter((li) => li.isReleased && !li.isAtGrading && li.unfulfilledQuantity > 0)
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
      atGrading: groupByCustomer(buckets.atGrading),
      partiallyReady: groupByCustomer(buckets.partiallyReady),
      waitingOnRelease: groupByCustomer(buckets.waitingOnRelease),
      completed: groupByCustomer(buckets.completed),
      cancelled: groupByCustomer(buckets.cancelled),
    },
    counts: {
      allUnfulfilled: buckets.allUnfulfilled.length,
      readyToShip: buckets.readyToShip.length,
      atGrading: buckets.atGrading.length,
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
  const rawOrders = await fetchAllStoreOrdersUnlimited(admin);
  const { allOrdersGrouped, groups, counts, pullListItems, focPullList } = processOrders(rawOrders);

  return jsonResponse({
    allOrdersGrouped,
    groups,
    counts,
    pullListItems,
    focPullList,
    totalOrdersCount: rawOrders.length,
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

const PAGE_SIZE = 100;

function formatDate(dateString) {
  if (!dateString) return "—";
  const d = parseSafeDate(dateString);
  if (!d) return "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function ChannelBadge({ sourceName }) {
  if (sourceName === "ebay") {
    return (
      <span
        style={{
          backgroundColor: "#0064D2",
          color: "#ffffff",
          fontWeight: "800",
          fontSize: "12px",
          padding: "3px 8px",
          borderRadius: "4px",
          display: "inline-block",
        }}
      >
        EBAY
      </span>
    );
  }
  const map = {
    shopify: { tone: "success", label: "Shopify" },
    whatnot: { tone: "attention", label: "Whatnot" },
  };
  const entry = map[sourceName] || { tone: undefined, label: sourceName };
  return <Badge tone={entry.tone}>{entry.label}</Badge>;
}

function AgingBadge({ agingStatus }) {
  if (agingStatus === "critical") {
    return <Badge tone="critical" icon={AlertTriangleIcon}>Overdue / Late Flag</Badge>;
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
    atGrading: { tone: "warning", label: "At CGC Grading" },
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
  const rawQ = query.trim().toLowerCase();
  const cleanQ = rawQ.replace(/^#+/, "").trim();
  const pureDigitsOnly = cleanQ.replace(/\D/g, "");

  return groups.filter((group) => {
    const custName = group.customerName.toLowerCase();
    const custEmail = group.customerEmail.toLowerCase();

    const matchesCustomer = custName.includes(rawQ) || custName.includes(cleanQ) || custEmail.includes(cleanQ);

    const matchesOrder = group.orders.some((o) => {
      const orderName = (o.name || "").toLowerCase();
      const orderCleanName = orderName.replace(/^#+/, "").trim();
      const orderDigits = orderName.replace(/\D/g, "");

      return (
        orderName.includes(rawQ) ||
        orderCleanName.includes(cleanQ) ||
        (pureDigitsOnly.length >= 3 && orderDigits.includes(pureDigitsOnly))
      );
    });

    return matchesCustomer || matchesOrder;
  });
}

function OrderSummaryRow({ order }) {
  const itemCount = order.lineItems.reduce((sum, li) => sum + li.quantity, 0);
  const worstAging = order.lineItems.reduce((worst, li) => {
    if (li.agingStatus === "critical") return "critical";
    if (li.agingStatus === "warning" && worst !== "critical") return "warning";
    return worst;
  }, null);

  return (
    <Box padding="300" background="bg-surface-secondary" borderRadius="200">
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="300" blockAlign="center">
            <Text as="span" fontWeight="bold">{order.name}</Text>
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

        <Divider />

        <BlockStack gap="150">
          {order.lineItems.map((li) => (
            <InlineStack key={li.id} align="space-between">
              <Text as="span">
                <Text as="span" fontWeight="bold">{li.unfulfilledQuantity}x</Text> of {li.quantity}x {li.title} {li.variantTitle ? ` — ${li.variantTitle}` : ""}
              </Text>
              <InlineStack gap="200">
                {li.isCgc && <Badge tone="warning">CGC Slab</Badge>}
                {li.focDate && <Badge tone="info">FOC: {li.focDate}</Badge>}
                <Text as="span" tone="subdued">
                  Release: {formatDate(li.releaseDate) === "—" ? "Immediate" : formatDate(li.releaseDate)}
                </Text>
                {li.isAtGrading && li.estimatedGradingReadyDate && (
                  <Badge tone={li.daysPastGradingEstimate ? "critical" : "info"} icon={ClockIcon}>
                    Est. Return: {formatDate(li.estimatedGradingReadyDate)}
                  </Badge>
                )}
                {order.isCancelled ? (
                  <Badge tone="critical">Voided</Badge>
                ) : (
                  <>
                    {!li.isReleased && !li.isAtGrading && <Badge tone="info">Pre-order</Badge>}
                    {li.isAtGrading && <Badge tone="warning">At Grading (60-90d)</Badge>}
                    {li.unfulfilledQuantity === 0 && <Badge tone="success" icon={CheckCircleIcon}>Shipped / Fulfilled</Badge>}
                    {li.unfulfilledQuantity > 0 && li.isReleased && !li.isAtGrading && (
                      <Badge tone="attention">Pending Pickup</Badge>
                    )}
                  </>
                )}
                <AgingBadge agingStatus={li.agingStatus} />
              </InlineStack>
            </InlineStack>
          ))}
        </BlockStack>
      </BlockStack>
    </Box>
  );
}

function BucketIndexTable({ groups, bucketKey, expandedGroups, onToggleGroup }) {
  if (!groups || groups.length === 0) {
    return (
      <Box paddingBlock="800">
        <EmptyState
          heading="Queue Cleared / No Matching Results"
          image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
        >
          <p>No matching order records found across the entire store database.</p>
        </EmptyState>
      </Box>
    );
  }

  return (
    <BlockStack gap="300">
      {groups.map((group) => {
        const isExpanded = expandedGroups.has(group.key);
        const primaryOrder = group.orders[0];
        const isEbayCustomer = group.orders.some((o) => o.sourceName === "ebay");

        return (
          <div
            key={group.key}
            style={{
              borderRadius: "8px",
              border: isEbayCustomer ? "2px solid #0064D2" : "1px solid #E1E3E5",
              boxShadow: isEbayCustomer ? "0 1px 6px rgba(0, 100, 210, 0.15)" : "none",
            }}
          >
            <Card padding="300">
              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="300" blockAlign="center">
                    <Button
                      variant="plain"
                      icon={isExpanded ? ChevronUpIcon : ChevronDownIcon}
                      onClick={() => onToggleGroup(group.key)}
                    />
                    <BlockStack gap="050">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span" fontWeight="bold" variant="bodyMd">{group.customerName}</Text>
                        {isEbayCustomer && (
                          <span
                            style={{
                              backgroundColor: "#0064D2",
                              color: "#ffffff",
                              fontWeight: "800",
                              fontSize: "11px",
                              padding: "2px 8px",
                              borderRadius: "4px",
                              letterSpacing: "0.5px",
                              display: "inline-block",
                            }}
                          >
                            EBAY
                          </span>
                        )}
                      </InlineStack>
                      <Text as="span" tone="subdued" variant="bodySm">{group.customerEmail}</Text>
                    </BlockStack>
                  </InlineStack>

                  <InlineStack gap="300" blockAlign="center">
                    {group.isMultiOrder ? (
                      <Badge tone="attention">{`${group.orders.length} Orders Combined`}</Badge>
                    ) : (
                      <Badge tone="info">{primaryOrder?.name}</Badge>
                    )}

                    <Text as="span" tone="subdued" variant="bodySm">
                      {group.shippingAddress?.city ? `${group.shippingAddress.city}, ${group.shippingAddress.country}` : "No Address"}
                    </Text>

                    {bucketKey === "cancelled" ? (
                      <Badge tone="critical">Cancelled</Badge>
                    ) : (
                      <AgingBadge agingStatus={group.worstAging} />
                    )}
                  </InlineStack>
                </InlineStack>

                {isExpanded && (
                  <Box paddingBlockStart="200">
                    <BlockStack gap="200">
                      {group.orders.map((order) => (
                        <OrderSummaryRow key={order.id} order={order} />
                      ))}
                    </BlockStack>
                  </Box>
                )}
              </BlockStack>
            </Card>
          </div>
        );
      })}
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

            <div style={{ width: "100%", overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #E1E3E5", backgroundColor: "#F7F8F9" }}>
                    <th style={{ padding: "10px 12px", width: "50%" }}>
                      <Text as="span" fontWeight="bold" tone="subdued">Physical Product Component (Quantity Needed)</Text>
                    </th>
                    <th style={{ padding: "10px 12px", width: "15%" }}>
                      <Text as="span" fontWeight="bold" tone="subdued">Release Date</Text>
                    </th>
                    <th style={{ padding: "10px 12px", width: "35%" }}>
                      <Text as="span" fontWeight="bold" tone="subdued">Order References</Text>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {group.items.map((item, idx) => (
                    <tr key={`${group.focDate}-${idx}`} style={{ borderBottom: "1px solid #E1E3E5" }}>
                      <td style={{ padding: "12px 12px", verticalAlign: "top" }}>
                        <Text as="span" fontWeight="bold">{item.quantity}x </Text>
                        <Text as="span" fontWeight="semibold">{item.title}</Text>
                        {item.variantTitle && (
                          <Text as="span" tone="subdued"> — {item.variantTitle}</Text>
                        )}
                      </td>
                      <td style={{ padding: "12px 12px", verticalAlign: "top", whiteSpace: "nowrap" }}>
                        <Text as="span">{formatDate(item.releaseDate)}</Text>
                      </td>
                      <td style={{ padding: "12px 12px", verticalAlign: "top" }}>
                        <div style={{ display: "flexWrap", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
                          {item.orders.map((o, oIdx) => (
                            <Tooltip key={oIdx} content={`${o.customer} (${o.sourceName})`}>
                              <Badge tone={o.sourceName === "ebay" ? "info" : "base"}>{o.orderName}</Badge>
                            </Tooltip>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </BlockStack>
        </Card>
      ))}
    </BlockStack>
  );
}

export default function FulfillmentDashboard() {
  const { allOrdersGrouped, groups, counts, pullListItems, focPullList, totalOrdersCount } = useLoaderData();

  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleManualSync = () => {
    setIsRefreshing(true);
    window.location.reload();
  };

  const b2g1Fetcher = useFetcher();
  const isSyncingB2G1 = b2g1Fetcher.state === "submitting" || b2g1Fetcher.state === "loading";

  const handleSyncB2G1 = () => {
    b2g1Fetcher.load("/api/sync-b2g1");
  };

  const [selectedTab, setSelectedTab] = useState(0);
  const [channelFilter, setChannelFilter] = useState([]);
  const [queryValue, setQueryValue] = useState("");
  const [expandedGroups, setExpandedGroups] = useState(new Set());

  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedTab, queryValue, channelFilter]);

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
    { id: "at-grading", content: "At Grading (CGC)", badgeCount: counts.atGrading, bucketKey: "atGrading" },
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

  useEffect(() => {
    if (queryValue.trim()) {
      setExpandedGroups(new Set(filteredGroups.map((r) => r.key)));
    }
  }, [queryValue, filteredGroups]);

  const totalPages = Math.ceil(filteredGroups.length / PAGE_SIZE) || 1;
  const paginatedGroups = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredGroups.slice(start, start + PAGE_SIZE);
  }, [filteredGroups, currentPage]);

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
    <AppProvider i18n={enTranslations}>
      <Page
        title="Release Date Automated Dispatch Board"
        subtitle={`Metafield Synchronization Queue Engine • Total Orders Ingested: ${totalOrdersCount}`}
        primaryAction={{
          content: "Sync Orders Now",
          icon: RefreshIcon,
          loading: isRefreshing,
          onAction: handleManualSync,
        }}
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
                    queryPlaceholder="Global Search: Type Order # (#5078) or Customer Name across ALL tabs..."
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
                        Global Search Active: Showing results matching "{queryValue}" across all store records.
                      </Text>
                    </Banner>
                  )}

                  {activeBucketKey === "atGrading" && !queryValue.trim() && (
                    <Banner tone="warning" icon={ClockIcon}>
                      <Text as="p" fontWeight="semibold">CGC Grading Processing Queue</Text>
                      <Text as="p">
                        All orders containing CGC items are tracked here from placement until marked fulfilled or tagged with <code>cgc-returned</code> / <code>cgc-processed</code>.
                      </Text>
                    </Banner>
                  )}

                  {selectedTab === 3 && !queryValue.trim() && (
                    <Banner tone="warning" icon={PackageIcon}>
                      <Text as="p" fontWeight="semibold">Warehouse Extract / Harvest Pull List</Text>
                      <Text as="p">Extract these line items from storage racks immediately. They are physically released but bound inside composite pre-order allocations.</Text>
                      <Box paddingBlockStart="300">
                        <PullListTable items={filteredPullListItems} />
                      </Box>
                    </Banner>
                  )}

                  {selectedTab === 4 && !queryValue.trim() && (
                    <BlockStack gap="300">
                      <Banner tone="info" icon={CalendarIcon}>
                        <Text as="p" fontWeight="semibold">FOC Weekly Ordering Pull List</Text>
                        <Text as="p">All unreleased items grouped by their FOC (Final Order Cutoff) deadline for vendor order placement.</Text>
                      </Banner>
                      <FocPullListView focGroups={focPullList} />
                    </BlockStack>
                  )}

                  <Box paddingBlockStart="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingSm" tone="subdued">
                        Orders in Queue ({filteredGroups.length} Total Customers) — Showing Page {currentPage} of {totalPages}
                      </Text>
                      {filteredGroups.length > PAGE_SIZE && (
                        <Pagination
                          hasPrevious={currentPage > 1}
                          onPrevious={() => setCurrentPage((p) => Math.max(1, p - 1))}
                          hasNext={currentPage < totalPages}
                          onNext={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                        />
                      )}
                    </InlineStack>

                    <Box paddingBlockStart="300">
                      <BucketIndexTable
                        groups={paginatedGroups}
                        bucketKey={activeBucketKey}
                        expandedGroups={expandedGroups}
                        onToggleGroup={onToggleGroup}
                      />
                    </Box>

                    {filteredGroups.length > PAGE_SIZE && (
                      <Box paddingBlockStart="400">
                        <InlineStack align="center">
                          <Pagination
                            hasPrevious={currentPage > 1}
                            onPrevious={() => {
                              setCurrentPage((p) => Math.max(1, p - 1));
                              window.scrollTo({ top: 0, behavior: 'smooth' });
                            }}
                            hasNext={currentPage < totalPages}
                            onNext={() => {
                              setCurrentPage((p) => Math.min(totalPages, p + 1));
                              window.scrollTo({ top: 0, behavior: 'smooth' });
                            }}
                          />
                        </InlineStack>
                      </Box>
                    )}
                  </Box>
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
                  <BucketBadge bucketKey="atGrading" />
                  <Text as="span">{counts.atGrading} Slabs at CGC</Text>
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

                {/* --- B2G1 AUTOMATION CONTROL SECTION --- */}
                <Divider />
                <BlockStack gap="200">
                  <Text as="h4" variant="headingSm" fontWeight="semibold">
                    Promotion Automation
                  </Text>

                  {b2g1Fetcher.data?.success && (
                    <Banner tone="success">
                      <Text as="p" variant="bodySm">
                        Promotion synced! Updated {b2g1Fetcher.data.updatedCount ?? 0} eligible products.
                      </Text>
                    </Banner>
                  )}

                  {b2g1Fetcher.data?.error && (
                    <Banner tone="critical">
                      <Text as="p" variant="bodySm">
                        {b2g1Fetcher.data.error}
                      </Text>
                    </Banner>
                  )}

                  <Button
                    icon={RefreshIcon}
                    loading={isSyncingB2G1}
                    onClick={handleSyncB2G1}
                    fullWidth
                  >
                    Sync B2G1 Eligible Products
                  </Button>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Scans books older than 3 months (metafield: custom.release_date) and syncs eligible tags.
                  </Text>
                </BlockStack>
                {/* --- END B2G1 CONTROL SECTION --- */}

              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    </AppProvider>
  );
}