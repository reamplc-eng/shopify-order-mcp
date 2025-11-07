const express = require('express');
const app = express();
app.use(express.json());

// Environment variables
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || '15c45d.myshopify.com';
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = '2025-01';

// Import MCP SDK
let SSEServerTransport, Server, ListToolsRequestSchema, CallToolRequestSchema;

try {
  const sseModule = require('@modelcontextprotocol/sdk/server/sse.js');
  const serverModule = require('@modelcontextprotocol/sdk/server/index.js');
  const typesModule = require('@modelcontextprotocol/sdk/types.js');
  
  SSEServerTransport = sseModule.SSEServerTransport;
  Server = serverModule.Server;
  ListToolsRequestSchema = typesModule.ListToolsRequestSchema;
  CallToolRequestSchema = typesModule.CallToolRequestSchema;
} catch (error) {
  console.error('Failed to load MCP SDK:', error.message);
  console.log('Continuing without MCP SDK - only /health endpoint will work');
}

// Create MCP Server
let mcpServer;
if (Server) {
  mcpServer = new Server(
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

  // Define tools
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'get_order',
          description: 'Get detailed information about a specific Shopify order by ID',
          inputSchema: {
            type: 'object',
            properties: {
              orderId: {
                type: 'string',
                description: 'The Shopify order ID',
              },
            },
            required: ['orderId'],
          },
        },
        {
          name: 'list_orders',
          description: 'Get a list of orders with optional filters',
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
          description: 'Update an existing order',
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
                description: 'Comma-separated tags',
              },
            },
            required: ['orderId'],
          },
        },
      ],
    };
  });

  // Handle tool calls
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
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
              text: `Order ${orderId} updated successfully`,
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
          text: `Error: ${error.message}`,
        }],
        isError: true,
      };
    }
  });
}

// Helper function for Shopify API
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    mcpServerReady: !!mcpServer,
    shopifyStore: SHOPIFY_STORE,
    hasAccessToken: !!SHOPIFY_ACCESS_TOKEN
  });
});

// SSE endpoint for MCP
if (mcpServer && SSEServerTransport) {
  app.post('/sse', async (req, res) => {
    try {
      const transport = new SSEServerTransport('/message', res);
      await mcpServer.connect(transport);
      
      req.on('close', () => {
        mcpServer.close();
      });
    } catch (error) {
      console.error('SSE connection error:', error);
      res.status(500).json({ error: error.message });
    }
  });
} else {
  app.post('/sse', (req, res) => {
    res.status(503).json({ 
      error: 'MCP SDK not available',
      message: 'Server is running but MCP functionality is not available'
    });
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ Health endpoint: /health`);
  console.log(`✅ MCP SSE endpoint: /sse`);
  console.log(`✅ Shopify Store: ${SHOPIFY_STORE}`);
  console.log(`✅ Has Access Token: ${!!SHOPIFY_ACCESS_TOKEN}`);
  if (!mcpServer) {
    console.warn('⚠️  MCP SDK not loaded - only health endpoint available');
  }
});
