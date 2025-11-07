const express = require('express');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const app = express();
app.use(express.json());

// Shopify configuration from environment variables
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || '15c45d.myshopify.com';
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = '2025-01';

// Create MCP Server
const server = new Server(
  {
    name: 'shopify-order-management',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define all available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_order',
        description: 'Get detailed information about a specific Shopify order by ID. Returns order details including line items, customer info, fulfillment status, and payment details.',
        inputSchema: {
          type: 'object',
          properties: {
            orderId: {
              type: 'string',
              description: 'The Shopify order ID (e.g., "5432109876543")',
            },
          },
          required: ['orderId'],
        },
      },
      {
        name: 'list_orders',
        description: 'Get a list of orders with optional filters. Returns up to 250 orders per request.',
        inputSchema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['open', 'closed', 'cancelled', 'any'],
              description: 'Filter by order status',
              default: 'any',
            },
            financial_status: {
              type: 'string',
              enum: ['pending', 'authorized', 'paid', 'partially_paid', 'refunded', 'voided', 'any'],
              description: 'Filter by financial status',
              default: 'any',
            },
            fulfillment_status: {
              type: 'string',
              enum: ['shipped', 'partial', 'unshipped', 'unfulfilled', 'any'],
              description: 'Filter by fulfillment status',
              default: 'any',
            },
            created_at_min: {
              type: 'string',
              description: 'Show orders created after this date (ISO 8601 format)',
            },
            limit: {
              type: 'number',
              description: 'Number of orders to return (1-250)',
              default: 50,
            },
          },
        },
      },
      {
        name: 'update_order',
        description: 'Update an existing order. Can update notes, tags, email, phone, and other order attributes.',
        inputSchema: {
          type: 'object',
          properties: {
            orderId: {
              type: 'string',
              description: 'The Shopify order ID to update',
            },
            note: {
              type: 'string',
              description: 'Add or update order notes',
            },
            tags: {
              type: 'string',
              description: 'Comma-separated tags to add to the order',
            },
            email: {
              type: 'string',
              description: 'Update customer email',
            },
          },
          required: ['orderId'],
        },
      },
      {
        name: 'fulfill_order',
        description: 'Create a fulfillment for an order. Marks orders as shipped and sends tracking information to customers.',
        inputSchema: {
          type: 'object',
          properties: {
            orderId: {
              type: 'string',
              description: 'The Shopify order ID to fulfill',
            },
            location_id: {
              type: 'string',
              description: 'Location ID for fulfillment',
              default: '87512351015',
            },
            tracking_number: {
              type: 'string',
              description: 'Tracking number for shipment',
            },
            tracking_company: {
              type: 'string',
              description: 'Shipping carrier (e.g., "USPS", "FedEx", "UPS")',
            },
            notify_customer: {
              type: 'boolean',
              description: 'Send fulfillment notification email to customer',
              default: true,
            },
          },
          required: ['orderId'],
        },
      },
      {
        name: 'cancel_order',
        description: 'Cancel an order and optionally refund payment. This action cannot be undone.',
        inputSchema: {
          type: 'object',
          properties: {
            orderId: {
              type: 'string',
              description: 'The Shopify order ID to cancel',
            },
            reason: {
              type: 'string',
              enum: ['customer', 'fraud', 'inventory', 'declined', 'other'],
              description: 'Reason for cancellation',
              default: 'customer',
            },
            refund: {
              type: 'boolean',
              description: 'Whether to refund the order',
              default: false,
            },
            email: {
              type: 'boolean',
              description: 'Send cancellation email to customer',
              default: true,
            },
          },
          required: ['orderId'],
        },
      },
      {
        name: 'create_refund',
        description: 'Create a refund for an order. Can refund full or partial amounts.',
        inputSchema: {
          type: 'object',
          properties: {
            orderId: {
              type: 'string',
              description: 'The Shopify order ID to refund',
            },
            amount: {
              type: 'number',
              description: 'Amount to refund in store currency',
            },
            reason: {
              type: 'string',
              enum: ['customer_changed_mind', 'defective', 'fraud', 'inventory', 'other'],
              description: 'Reason for refund',
            },
            restock: {
              type: 'boolean',
              description: 'Whether to restock refunded items',
              default: true,
            },
            notify: {
              type: 'boolean',
              description: 'Send refund notification to customer',
              default: true,
            },
          },
          required: ['orderId', 'amount', 'reason'],
        },
      },
      {
        name: 'get_order_analytics',
        description: 'Get analytics and statistics for orders within a date range.',
        inputSchema: {
          type: 'object',
          properties: {
            start_date: {
              type: 'string',
              description: 'Start date for analytics (ISO 8601 format)',
            },
            end_date: {
              type: 'string',
              description: 'End date for analytics (ISO 8601 format)',
            },
            group_by: {
              type: 'string',
              enum: ['day', 'week', 'month'],
              description: 'How to group the analytics data',
              default: 'day',
            },
          },
          required: ['start_date', 'end_date'],
        },
      },
    ],
  };
});

// Helper function to make Shopify API requests
async function shopifyRequest(endpoint, method = 'GET', body = null) {
  const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/${endpoint}`;
  
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
    },
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  const response = await fetch(url, options);
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Shopify API error: ${response.status} - ${error}`);
  }
  
  return await response.json();
}

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_order': {
        const data = await shopifyRequest(`orders/${args.orderId}.json`);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(data.order, null, 2),
          }],
        };
      }

      case 'list_orders': {
        const params = new URLSearchParams();
        if (args.status && args.status !== 'any') params.append('status', args.status);
        if (args.financial_status && args.financial_status !== 'any') params.append('financial_status', args.financial_status);
        if (args.fulfillment_status && args.fulfillment_status !== 'any') params.append('fulfillment_status', args.fulfillment_status);
        if (args.created_at_min) params.append('created_at_min', args.created_at_min);
        params.append('limit', args.limit || 50);
        
        const data = await shopifyRequest(`orders.json?${params.toString()}`);
        return {
          content: [{
            type: 'text',
            text: `Found ${data.orders.length} orders:\n\n${JSON.stringify(data.orders, null, 2)}`,
          }],
        };
      }

      case 'update_order': {
        const { orderId, ...updates } = args;
        const data = await shopifyRequest(`orders/${orderId}.json`, 'PUT', { order: updates });
        return {
          content: [{
            type: 'text',
            text: `Order ${orderId} updated successfully:\n\n${JSON.stringify(data.order, null, 2)}`,
          }],
        };
      }

      case 'fulfill_order': {
        const { orderId, ...fulfillmentData } = args;
        const data = await shopifyRequest(`orders/${orderId}/fulfillments.json`, 'POST', {
          fulfillment: fulfillmentData,
        });
        return {
          content: [{
            type: 'text',
            text: `Order ${orderId} fulfilled successfully:\n\n${JSON.stringify(data.fulfillment, null, 2)}`,
          }],
        };
      }

      case 'cancel_order': {
        const { orderId, ...cancelData } = args;
        const data = await shopifyRequest(`orders/${orderId}/cancel.json`, 'POST', cancelData);
        return {
          content: [{
            type: 'text',
            text: `Order ${orderId} cancelled successfully:\n\n${JSON.stringify(data.order, null, 2)}`,
          }],
        };
      }

      case 'create_refund': {
        const { orderId, ...refundData } = args;
        const data = await shopifyRequest(`orders/${orderId}/refunds.json`, 'POST', {
          refund: refundData,
        });
        return {
          content: [{
            type: 'text',
            text: `Refund created for order ${orderId}:\n\n${JSON.stringify(data.refund, null, 2)}`,
          }],
        };
      }

      case 'get_order_analytics': {
        const { start_date, end_date, group_by } = args;
        const params = new URLSearchParams({
          created_at_min: start_date,
          created_at_max: end_date,
          limit: 250,
        });
        
        const data = await shopifyRequest(`orders.json?${params.toString()}`);
        
        const analytics = {
          total_orders: data.orders.length,
          total_sales: data.orders.reduce((sum, order) => sum + parseFloat(order.total_price), 0),
          average_order_value: 0,
          fulfillment_rate: 0,
        };
        
        analytics.average_order_value = analytics.total_sales / analytics.total_orders || 0;
        analytics.fulfillment_rate = (data.orders.filter(o => o.fulfillment_status === 'fulfilled').length / analytics.total_orders) * 100;
        
        return {
          content: [{
            type: 'text',
            text: `Order Analytics (${start_date} to ${end_date}):\n\n${JSON.stringify(analytics, null, 2)}`,
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error executing ${name}: ${error.message}`,
      }],
      isError: true,
    };
  }
});

// SSE Endpoint
app.post('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/message', res);
  await server.connect(transport);
  
  req.on('close', () => {
    server.close();
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MCP Server running on port ${PORT}`);
  console.log(`SSE endpoint available at /sse`);
});