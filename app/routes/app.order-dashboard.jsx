import { useMemo, useState, useCallback } from "react";
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
  Collapsible,
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
} from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";

const jsonResponse = (data) => {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};

/* ------------------------------------------------------------------ */
/*  1. BACKEND API ENGINE (UPDATED GRAPHQL SCHEMAS)                   */
/* ------------------------------------------------------------------ */

const UNFULFILLED_ORDERS_QUERY = `#graphql
  query FetchUnfulfilledReleaseQueue($cursor: String) {
    orders(
      first: 50
      after: $cursor
      query: "fulfillment_status:unfulfilled"
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
          sourceName
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
          lineItems(first: 100) {
            edges {
              node {
                id
                title
                variantTitle
                quantity
                unfulfilledQuantity
                product {
                  id
                  metafield(namespace: "custom", key: "release_date") {
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

async function fetchAllUnfulfilledOrders(admin) {
  const orders = [];
  let cursor = null;
  let hasNextPage = true;
  let pageCount = 0;
  const MAX_PAGES = 10;

  while (hasNextPage && pageCount < MAX_PAGES) {
    const response = await admin.graphql(UNFULFILLED_ORDERS_QUERY, {
      variables: { cursor },
    });
    const payload = await response.json();

    if (payload.errors) {
      throw new Response(JSON.stringify(payload.errors), { status: 500 });
    }

    const ordersConnection = payload.data.orders;
    orders.push(...ordersConnection.edges.map((edge) => edge.node));

    hasNextPage = ordersConnection.pageInfo.hasNextPage;
    cursor = ordersConnection.pageInfo.endCursor;
    pageCount += 1;
  }

  return orders;
}

/* ------------------------------------------------------------------ */
/*  2. ALGORITHMIC DATA PROCESSING & STRATIFICATION RUNTIME           */
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

function buildCustomerKey(order) {
  const c = order.customer;
  const email = order.email;
  const a = order.shippingAddress;
  return [c?.firstName, c?.lastName, email, a?.address1, a?.zip]
    .map((part) => (part || "").toString().trim().toLowerCase())
    .join("|");
}

function processOrder(rawOrder, today) {
  const rawLineItems = rawOrder.lineItems.edges
    .map((edge) => edge.node)
    .filter((li) => li.unfulfilledQuantity > 0);

  if (rawLineItems.length === 0) return null;

  const lineItems = rawLineItems.map((li) => {
    const releaseDateRaw = li.product?.metafield?.value || null;
    const releaseDate = releaseDateRaw ? new Date(releaseDateRaw) : null;
    const isReleased = !releaseDate || releaseDate <= today;

    let daysPastRelease = null;
    let agingStatus = null;
    
    if (isReleased && releaseDate) {
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
      isReleased,
      daysPastRelease,
      agingStatus,
    };
  });

  const allReleased = lineItems.every((li) => li.isReleased);
  const noneReleased = lineItems.every((li) => !li.isReleased);

  let bucket;
  if (allReleased) bucket = "readyToShip";
  else if (noneReleased) bucket = "waitingOnRelease";
  else bucket = "partiallyReady";

  return {
    id: rawOrder.id,
    name: rawOrder.name,
    createdAt: rawOrder.createdAt,
    sourceName: (rawOrder.sourceName || "shopify").toLowerCase(),
    tags: rawOrder.tags || [],
    customer: rawOrder.customer,
    email: rawOrder.email,
    shippingAddress: rawOrder.shippingAddress,
    lineItems,
    bucket,
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

function processOrders(rawOrders) {
  const today = startOfToday();
  const buckets = { readyToShip: [], partiallyReady: [], waitingOnRelease: [] };
  const pullListItems = [];

  for (const rawOrder of rawOrders) {
    const processed = processOrder(rawOrder, today);
    if (!processed) continue;

    buckets[processed.bucket].push(processed);

    if (processed.bucket === "partiallyReady") {
      processed.lineItems
        .filter((li) => li.isReleased)
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

  return {
    groups: {
      readyToShip: groupByCustomer(buckets.readyToShip),
      partiallyReady: groupByCustomer(buckets.partiallyReady),
      waitingOnRelease: groupByCustomer(buckets.waitingOnRelease),
    },
    counts: {
      readyToShip: buckets.readyToShip.length,
      partiallyReady: buckets.partiallyReady.length,
      waitingOnRelease: buckets.waitingOnRelease.length,
    },
    pullListItems: pullListItems.sort((a, b) => (b.daysPastRelease || 0) - (a.daysPastRelease || 0)),
  };
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const rawOrders = await fetchAllUnfulfilledOrders(admin);
  const { groups, counts, pullListItems } = processOrders(rawOrders);

  return jsonResponse({
    groups,
    counts,
    pullListItems,
    fetchedAt: new Date().toISOString(),
  });
};

/* ------------------------------------------------------------------ */
/*  3. USER INTERFACE GRAPHICAL RENDERING ENGINE                      */
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
    readyToShip: { tone: "success", label: "Ready to Ship" },
    partiallyReady: { tone: "attention", label: "Partially Ready" },
    waitingOnRelease: { tone: "info", label: "Waiting on Release" },
  };
  const entry = map[bucketKey];
  return <Badge tone={entry.tone}>{entry.label}</Badge>;
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
  const itemCount = order.lineItems.reduce((sum, li) => sum + li.unfulfilledQuantity, 0);
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
          <Text as="span" tone="subdued">{formatDate(order.createdAt)}</Text>
          <Text as="span" tone="subdued">{itemCount} Allocated Item(s)</Text>
        </InlineStack>
        <AgingBadge agingStatus={worstAging} />
      </InlineStack>
      <Box paddingBlockStart="150">
        <BlockStack gap="100">
          ={order.lineItems.map((li) => (
            <InlineStack key={li.id} align="space-between">
              <Text as="span" tone="subdued">
                {li.unfulfilledQuantity}x {li.title} {li.variantTitle ? ` — ${li.variantTitle}` : ""}
              </Text>
              <InlineStack gap="200">
                <Text as="span" tone="subdued">
                  Release Status: {formatDate(li.releaseDate) === "—" ? "Immediate" : formatDate(li.releaseDate)}
                </Text>
                {!li.isReleased && <Badge tone="info">Future Pre-order</Badge>}
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
          heading="Queue Cleared"
          image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
        >
          <p>No unfulfilled matching conditions found for this tracking queue block.</p>
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
          { title: "Pack Destination" },
          { title: "Pending Orders" },
          { title: "Delivery Destination" },
          { title: "Marketplace Track" },
          { title: "Aging Threshold" },
        ]}
      >
        {groups.map((group, index) => {
          const isExpanded = expandedGroups.has(group.key);
          const primaryOrder = group.orders[0];

          return (
            <IndexTable.Row id={group.key} key={group.key} position={index} tone={group.isMultiOrder ? "subdued" : undefined}>
              <IndexTable.Cell>
                <InlineStack gap="200" blockAlign="center">
                  {group.isMultiOrder && (
                    <Button
                      variant="tertiary"
                      icon={isExpanded ? ChevronUpIcon : ChevronDownIcon}
                      onClick={() => onToggleGroup(group.key)}
                    />
                  )}
                  <BlockStack gap="0">
                    <Text as="span" fontWeight="semibold">{group.customerName}</Text>
                    <Text as="span" tone="subdued">{group.customerEmail}</Text>
                  </BlockStack>
                </InlineStack>
              </IndexTable.Cell>
              <IndexTable.Cell>
                {group.isMultiOrder ? (
                  <Badge tone="attention">{`${group.orders.length} Combined Separate Orders`}</Badge>
                ) : (
                  <Text as="span">{primaryOrder.name}</Text>
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
                <AgingBadge agingStatus={group.worstAging} />
              </IndexTable.Cell>
            </IndexTable.Row>
          );
        })}
      </IndexTable>

      {groups
        .filter((g) => g.isMultiOrder && expandedGroups.has(g.key))
        .map((group) => (
          <Collapsible key={`${group.key}-detail`} open={expandedGroups.has(group.key)} id={`${group.key}-collapsible`}>
            <Box padding="400" background="bg-surface-secondary" borderBlockStartWidth="025" borderColor="border">
              <BlockStack gap="300">
                <Text as="h3" fontWeight="semibold">Consolidated Shipping Block — {group.customerName}</Text>
                {group.orders.map((order, i) => (
                  <Box key={order.id}>
                    <OrderSummaryRow order={order} indented />
                    {i < group.orders.length - 1 && <Divider />}
                  </Box>
                ))}
              </BlockStack>
            </Box>
          </Collapsible>
        ))}
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

export default function FulfillmentDashboard() {
  const { groups, counts, pullListItems, fetchedAt } = useLoaderData();

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
    { id: "ready-to-ship", content: "Ready to Ship", badgeCount: counts.readyToShip, bucketKey: "readyToShip" },
    { id: "partially-ready", content: "Partially Ready", badgeCount: counts.partiallyReady, bucketKey: "partiallyReady" },
    { id: "waiting-on-release", content: "Waiting on Release", badgeCount: counts.waitingOnRelease, bucketKey: "waitingOnRelease" },
  ];

  const activeBucketKey = tabs[selectedTab].bucketKey;

  const filteredGroups = useMemo(() => {
    const base = groups[activeBucketKey];
    const byChannel = filterGroupsByChannel(base, channelFilter);
    return filterGroupsByQuery(byChannel, queryValue);
  }, [groups, activeBucketKey, channelFilter, queryValue]);

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
      <Page
        title="Release Date Automated Dispatch Board"
        subtitle="Metafield Synchronization Queue Engine (Zero Manual Tagging Active)"
        secondaryActions={[{ content: "Force Live Reload", onAction: () => window.location.reload() }]}
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
                    queryPlaceholder="Search dynamic records by buyer or order number..."
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

                  {selectedTab === 1 && (
                    <Banner tone="warning" icon={PackageIcon}>
                      <Text as="p" fontWeight="semibold">Warehouse Extract / Harvest Pull List</Text>
                      <Text as="p">Extract these line items from storage racks immediately. They are physically released but bound inside composite pre-order allocations.</Text>
                      <Box paddingBlockStart="300">
                        <PullListTable items={filteredPullListItems} />
                      </Box>
                    </Banner>
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