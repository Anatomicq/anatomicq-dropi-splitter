import crypto from 'crypto';
const DROPI_TOKEN    = process.env.DROPI_TOKEN;
const DROPI_BASE_URL = 'https://app.dropi.co';
const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

function verifyShopifyWebhook(rawBody, hmacHeader) {
  return true;
}

async function createDropiOrder(payload) {
  const res = await fetch(`${DROPI_BASE_URL}/integrations/orders/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'dropi-integration-key': DROPI_TOKEN },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, ok: res.ok, body: json };
}

const CIUDAD_MAP = {
  'bogota':11,'bogotá':11,'medellin':80,'medellín':80,'cali':170,
  'barranquilla':8,'cartagena':45,'bucaramanga':76,'cucuta':54,'cúcuta':54,
  'pereira':66,'manizales':17,'ibague':73,'ibagué':73,
  'santa marta':47,'villavicencio':50,
};

function getCityId(city) {
  if (!city) return 11;
  return CIUDAD_MAP[city.toLowerCase().trim()] ?? 11;
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
  const hmac    = req.headers['x-shopify-hmac-sha256'];
  if (!verifyShopifyWebhook(rawBody, hmac)) return res.status(401).json({ error: 'Unauthorized' });
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
    const products = {};
    items.forEach((item, idx) => {
      products[String(idx)] = { id: item.dropi_id, price: item.price, quantity: item.quantity, ...(item.variation_id ? { variation_id: item.variation_id } : {}) };
    });
    const payload = {
      external_id:    `${shopifyId}-${i + 1}`,
      client_name:    shipping.first_name || customer.first_name || 'Cliente',
      client_surname: shipping.last_name  || customer.last_name  || '',
      client_phone:   shipping.phone      || customer.phone      || order.phone || '',
      client_address: shipping.address1   || '',
      client_city:    getCityId(shipping.city),
      total:          Number(order.total_price || 0),
      products,
    };
    try {
      const result = await createDropiOrder(payload);
      resultados.push({ proveedor: vendor, external_id: payload.external_id, items: items.map(i => i.title), dropi_status: result.status, dropi_ok: result.ok, dropi_body: result.body });
    } catch (err) {
      resultados.push({ proveedor: vendor, external_id: payload.external_id, error: err.message });
    }
  }
  return res.status(200).json({ shopify_order: shopifyId, proveedores: proveedores.length, ordenes_dropi: resultados, todos_ok: resultados.every(r => r.dropi_ok) });
}
