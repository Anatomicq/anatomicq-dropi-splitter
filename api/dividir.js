/**
 * DIVISOR por WEBHOOK (orders/create). Reemplaza al divisor viejo.
 * Toma un pedido multi-proveedor y crea 1 pedido por proveedor, repartiendo
 * envío + $5.000 contraentrega PROPORCIONAL, RESTANDO el descuento del cupón
 * (discount_allocations) por producto, pide preparación (Fulfillment Dropi) y
 * cancela el original.
 *
 * Env (Vercel): SHOPIFY_ACCESS_TOKEN (write_orders, read_orders, fulfillment),
 *               SHOPIFY_WEBHOOK_SECRET (mismo secreto de los webhooks de tienda).
 */
import crypto from 'crypto';

const STORE = 'xx0kf5-dk.myshopify.com';
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const API = '2025-01';

function verifyShopifyWebhook(rawBody, hmacHeader) {
  if (!SECRET || !hmacHeader) return false;
  const digest = crypto.createHmac('sha256', SECRET).update(rawBody, 'utf8').digest('base64');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(String(hmacHeader), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''; req.on('data', c => (data += c)); req.on('end', () => resolve(data)); req.on('error', reject);
  });
}
async function gql(query, variables) {
  const res = await fetch(`https://${STORE}/admin/api/${API}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors) throw new Error('GraphQL: ' + JSON.stringify(j.errors).slice(0, 400));
  return j.data;
}
const money = (n) => '$' + Math.round(n).toLocaleString('es-CO');

const Q_ORDER = `query($id:ID!){ order(id:$id){
  id name email cancelledAt displayFulfillmentStatus tags paymentGatewayNames
  shippingLine { title originalPriceSet { shopMoney { amount } } }
  shippingAddress { firstName lastName address1 address2 city province countryCodeV2 zip phone }
  lineItems(first:100){ edges { node {
    title quantity vendor
    originalUnitPriceSet { shopMoney { amount } }
    discountAllocations { allocatedAmountSet { shopMoney { amount } } }
    variant { id }
    product { tags }
  } } }
} }`;

// Pack de N: tag "packN" (pack2, pack3, ...) -> a Dropi se manda xN unidades.
const packMult = (it) => {
  const tag = ((it.product && it.product.tags) || []).map(String).find(x => /^pack\d+$/i.test(x.trim()));
  const n = tag ? parseInt(tag.trim().replace(/pack/i, ''), 10) : 1;
  return (n >= 2 && n <= 20) ? n : 1;
};
// Descuento (cupon) que Shopify YA repartio proporcional en cada linea.
const descLinea = (it) => (it.discountAllocations || []).reduce((s, a) => s + parseFloat(a.allocatedAmountSet.shopMoney.amount), 0);
// Valor NETO de la linea = (precio original x cantidad) - descuento repartido. Nunca negativo.
const netoLinea = (it) => Math.max(0, parseFloat(it.originalUnitPriceSet.shopMoney.amount) * it.quantity - descLinea(it));

const M_ORDER_CREATE = `mutation($order:OrderCreateOrderInput!,$options:OrderCreateOptionsInput){ orderCreate(order:$order, options:$options){ order{ id name displayFinancialStatus } userErrors{ field message } } }`;
const GATEWAY_COD = 'Cash on Delivery (COD)';
const Q_FO = `query($id:ID!){ order(id:$id){ fulfillmentOrders(first:10){ edges{ node{ id status requestStatus } } } } }`;
const M_FO_REQUEST = `mutation($id:ID!){ fulfillmentOrderSubmitFulfillmentRequest(id:$id){ submittedFulfillmentOrder{ id requestStatus } userErrors{ field message } } }`;
const M_ORDER_TAG = `mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id, tags:$tags){ userErrors{ field message } } }`;
const M_ORDER_CANCEL = `mutation($id:ID!){ orderCancel(orderId:$id, reason:OTHER, refund:false, restock:false, notifyCustomer:false){ userErrors{ field message } } }`;

async function pedirPreparacion(orderId) {
  const d = await gql(Q_FO, { id: orderId });
  const fos = d.order.fulfillmentOrders.edges.map(e => e.node);
  for (const fo of fos) {
    try {
      const r = await gql(M_FO_REQUEST, { id: fo.id });
      const errs = r.fulfillmentOrderSubmitFulfillmentRequest.userErrors;
      console.log(`      preparacion ${fo.id.split('/').pop()}: ${errs.length ? 'error: ' + JSON.stringify(errs) : 'solicitada'}`);
    } catch (e) { console.log(`      preparacion: ${e.message}`); }
  }
}

async function dividirPedido(o) {
  // Idempotencia: no re-dividir ni tocar cancelados.
  if (o.cancelledAt) { console.log(`${o.name}: cancelado, se omite.`); return; }
  if ((o.tags || []).map(t => String(t).toLowerCase()).includes('dividido')) { console.log(`${o.name}: ya dividido, se omite.`); return; }

  const todos = o.lineItems.edges.map(e => e.node);
  const productos = todos.filter(it => it.vendor && it.vendor.trim());
  const extras = todos.filter(it => !it.vendor || !it.vendor.trim());
  const porProv = {};
  for (const it of productos) (porProv[it.vendor] = porProv[it.vendor] || []).push(it);
  const provs = Object.keys(porProv);
  if (provs.length < 1) { console.log(`${o.name}: sin productos con proveedor, se omite.`); return; }

  const esCOD = (o.paymentGatewayNames || []).some(g => /cod|contra\s?entrega|cash on delivery/i.test(g));
  const gatewayOrig = (o.paymentGatewayNames || [])[0] || 'manual';
  const hayPack = productos.some(it => packMult(it) > 1);
  if (provs.length < 2 && !esCOD && !hayPack) { console.log(`${o.name}: un solo proveedor (tarjeta) sin pack, se omite.`); return; }
  if (productos.some(it => !it.variant || !it.variant.id)) { console.log(`${o.name}: productos sin variante (borrados) - se omite.`); return; }

  const costoExtras = extras.reduce((s, it) => s + parseFloat(it.originalUnitPriceSet.shopMoney.amount) * it.quantity, 0);
  const costoEnvio = parseFloat(o.shippingLine?.originalPriceSet?.shopMoney?.amount || 0);
  const contraentregaExistente = extras.filter(it => /contra\s?entrega/i.test(it.title || '')).reduce((s, it) => s + parseFloat(it.originalUnitPriceSet.shopMoney.amount) * it.quantity, 0);
  const recargoCOD = esCOD ? Math.max(0, 5000 - contraentregaExistente) : 0;
  const costoEnvioTotal = costoExtras + costoEnvio + recargoCOD;

  // Precio unitario NETO (cupon restado proporcional) + cantidad con pack.
  for (const it of productos) {
    const mult = packMult(it);
    it._q = it.quantity * mult;
    it._unit = it._q > 0 ? Math.round(netoLinea(it) / it._q) : 0;
    it._lineTotal = it._unit * it._q;
  }
  const totalProductos = productos.reduce((s, it) => s + it._lineTotal, 0);

  const dir = o.shippingAddress || {};
  const shippingAddress = {
    firstName: dir.firstName, lastName: dir.lastName, address1: dir.address1, address2: dir.address2,
    city: dir.city, province: dir.province, countryCode: dir.countryCodeV2, zip: dir.zip, phone: dir.phone,
  };

  console.log(`${o.name} -> dividir en ${provs.length} | envio total ${money(costoEnvioTotal)} PROPORCIONAL`);
  let i = 0;
  for (const v of provs) {
    i++;
    const itemsProv = porProv[v];
    const subtotalV = itemsProv.reduce((s, it) => s + it._lineTotal, 0);
    const envioV = totalProductos > 0 ? Math.round(costoEnvioTotal * (subtotalV / totalProductos)) : Math.round(costoEnvioTotal / provs.length);
    const total = Math.round(subtotalV + envioV);
    const pct = totalProductos > 0 ? Math.round(subtotalV / totalProductos * 100) : Math.round(100 / provs.length);
    const lineItems = itemsProv.map(it => (
      { variantId: it.variant.id, quantity: it._q, priceSet: { shopMoney: { amount: String(it._unit), currencyCode: 'COP' } } }
    ));
    console.log(`   ${i}/${provs.length} [${v}] producto ${money(subtotalV)} (${pct}%) + envio ${money(envioV)} | total ${money(total)} | ${esCOD ? 'CONTRAENTREGA' : 'TARJETA'}`);

    const transaccion = esCOD
      ? { gateway: GATEWAY_COD, kind: 'SALE', status: 'PENDING', amountSet: { shopMoney: { amount: String(total), currencyCode: 'COP' } } }
      : { gateway: gatewayOrig, kind: 'SALE', status: 'SUCCESS', amountSet: { shopMoney: { amount: String(total), currencyCode: 'COP' } } };
    const order = {
      email: o.email, lineItems, shippingAddress,
      shippingLines: [{ title: esCOD ? 'Contraentrega' : 'Envio', priceSet: { shopMoney: { amount: String(envioV), currencyCode: 'COP' } } }],
      transactions: [transaccion],
      tags: ['dividido', 'origen-' + o.name.replace('#', '')],
      note: 'Dividido automaticamente de ' + o.name,
    };
    const options = { sendReceipt: false, sendFulfillmentReceipt: false };
    const c = await gql(M_ORDER_CREATE, { order, options });
    if (c.orderCreate.userErrors.length) { console.log('      ERROR crear pedido: ' + JSON.stringify(c.orderCreate.userErrors)); continue; }
    const nuevo = c.orderCreate.order;
    console.log(`      creado ${nuevo.name} (pago: ${nuevo.displayFinancialStatus})`);
    await pedirPreparacion(nuevo.id);
  }

  // Marcar y cancelar el original (sin reembolso).
  await gql(M_ORDER_TAG, { id: o.id, tags: ['dividido'] });
  const r = await gql(M_ORDER_CANCEL, { id: o.id });
  console.log(`   original ${o.name} ${r.orderCancel.userErrors.length ? 'error cancelar: ' + JSON.stringify(r.orderCancel.userErrors) : 'CANCELADO (sin reembolso)'}`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const rawBody = await getRawBody(req);
  if (!verifyShopifyWebhook(rawBody, req.headers['x-shopify-hmac-sha256']))
    return res.status(401).json({ error: 'Unauthorized' });

  let payload;
  try { payload = JSON.parse(rawBody); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  const gid = payload.admin_graphql_api_id || (payload.id ? `gid://shopify/Order/${payload.id}` : null);
  if (!gid) return res.status(400).json({ error: 'Sin ID de pedido' });

  // Responder 200 rapido; procesar igual (Vercel espera a que termine el handler).
  try {
    const d = await gql(Q_ORDER, { id: gid });
    if (!d.order) { console.log(`Pedido ${gid} no encontrado`); return res.status(200).json({ ok: true, skip: 'no encontrado' }); }
    await dividirPedido(d.order);
    return res.status(200).json({ ok: true, order: d.order.name });
  } catch (err) {
    console.error('Error divisor:', err.message);
    return res.status(200).json({ ok: false, error: err.message }); // 200 para que Shopify no reintente en loop
  }
}
