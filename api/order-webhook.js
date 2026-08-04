import crypto from 'crypto';
const DROPI_TOKEN    = process.env.DROPI_TOKEN;
const DROPI_BASE_URL = 'https://api.dropi.co';
const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
function verifyShopifyWebhook(rawBody, hmacHeader) {
  if (!SHOPIFY_SECRET) return true;
  const digest = crypto
    .createHmac('sha256', SHOPIFY_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');
  return digest === hmacHeader;
}
async function createDropiOrder(payload) {
  const res = await fetch(`${DROPI_BASE_URL}/integrations/order/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'dropi-integration-key': DROPI_TOKEN },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, ok: res.ok, body: json };
}
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const rawBody = await getRawBody(req);
  if (!verifyShopifyWebhook(rawBody, req.headers['x-shopify-hmac-sha256'])) return res.status(401).json({ error: 'Unauthorized' });
  let order;
  try { order = JSON.parse(rawBody); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  const shipping  = order.shipping_address || order.billing_address || {};
  const customer  = order.customer || {};
  const shopifyId = String(order.order_number || order.id);
  const grupos = {};
  for (const item of order.line_items) {
    const dropiId = parseInt(item.sku, 10);
    if (!dropiId || isNaN(dropiId)) continue;
    const vendor = item.vendor || 'sin_proveedor';
    if (!grupos[vendor]) grupos[vendor] = [];
    grupos[vendor].push({ dropi_id: dropiId, price: Math.round(Number(item.price)), quantity: item.quantity, variation_id: item.variant_id || null, title: item.title });
  }
  const proveedores = Object.keys(grupos);
  if (!proveedores.length) return res.status(200).json({ message: 'Sin items con SKU de Dropi' });
  const resultados = [];
  for (let i = 0; i < proveedores.length; i++) {
    const vendor  = proveedores[i];
    const items   = grupos[vendor];
    const products = items.map(item => ({
      id:           item.dropi_id,
      price:        item.price,
      quantity:     item.quantity,
      variation_id: item.variation_id || null,
    }));
    const payload = {
      calculate_costs_and_shiping: true,
      state:             shipping.province || 'CUNDINAMARCA',
      city:              shipping.city     || 'BOGOTA',
      name:              shipping.first_name || customer.first_name || 'Cliente',
      surname:           shipping.last_name  || customer.last_name  || '',
      phone:             (shipping.phone || customer.phone || order.phone || '').replace(/\D/g,''),
      dir:               shipping.address1 || '',
      notes:             `Pedido Shopify #${shopifyId}`,
      payment_method_id: 1,
      rate_type:         'CON RECAUDO',
      type:              'FINAL_ORDER',
      total_order:       Number(order.total_price || 0),
      external_id:       `${shopifyId}-${i + 1}`,
      products,
    };
    console.log('PAYLOAD A DROPI:', JSON.stringify(payload));
    try {
      const result = await createDropiOrder(payload);
      console.log('DROPI RESPONSE:', JSON.stringify(result.body));
      resultados.push({ proveedor: vendor, external_id: payload.external_id, items: items.map(i => i.title), dropi_status: result.status, dropi_ok: result.ok, dropi_body: result.body });
    } catch (err) {
      console.log('DROPI ERROR:', err.message);
      resultados.push({ proveedor: vendor, external_id: payload.external_id, error: err.message });
    }
  }
  return res.status(200).json({ shopify_order: shopifyId, proveedores: proveedores.length, ordenes_dropi: resultados, todos_ok: resultados.every(r => r.dropi_ok) });
}
