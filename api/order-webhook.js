import crypto from 'crypto';

const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE  = 'xx0kf5-dk.myshopify.com';

function verifyShopifyWebhook(rawBody, hmacHeader) {
  if (!SHOPIFY_SECRET) return true;
  const digest = crypto
    .createHmac('sha256', SHOPIFY_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');
  return digest === hmacHeader;
}

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function requestFulfillment(orderId, fulfillmentOrderId) {
  const url = `https://${SHOPIFY_STORE}/admin/api/2026-07/fulfillment_orders/${fulfillmentOrderId}/fulfillment_request.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    },
    body: JSON.stringify({
      fulfillment_request: {
        message: `Pedido automático #${orderId}`
      }
    }),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, ok: res.ok, body: json };
}

async function getFulfillmentOrders(orderId) {
  const url = `https://${SHOPIFY_STORE}/admin/api/2026-07/orders/${orderId}/fulfillment_orders.json`;
  const res = await fetch(url, {
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    },
  });
  const json = await res.json();
  return json.fulfillment_orders || [];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rawBody = await getRawBody(req);
  if (!verifyShopifyWebhook(rawBody, req.headers['x-shopify-hmac-sha256']))
    return res.status(401).json({ error: 'Unauthorized' });

  let order;
  try { order = JSON.parse(rawBody); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const orderId = order.id;
  console.log(`Pedido recibido: #${order.order_number} (ID: ${orderId})`);

  try {
    const fulfillmentOrders = await getFulfillmentOrders(orderId);
    console.log(`Fulfillment orders encontradas: ${fulfillmentOrders.length}`);

    const resultados = [];
    for (const fo of fulfillmentOrders) {
      console.log(`Procesando fulfillment order ${fo.id} - status: ${fo.status}`);
      if (fo.status === 'open') {
        const result = await requestFulfillment(orderId, fo.id);
        console.log(`Fulfillment request resultado:`, JSON.stringify(result.body));
        resultados.push({ fulfillment_order_id: fo.id, status: result.status, ok: result.ok });
      }
    }

    return res.status(200).json({ order: order.order_number, resultados });
  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
