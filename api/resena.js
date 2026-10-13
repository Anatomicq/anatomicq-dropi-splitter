/**
 * Boton "Dejar mi resena" de la plantilla de WhatsApp "entregado" (Chatea Pro).
 *
 * URL del boton en Meta (dinamica):
 *   https://anatomicq-dropi-splitter.vercel.app/api/resena?d={{1}}
 * {{1}} en Chatea Pro = {{[Logistica] Order ID}}-{{[Shopify] Producto 1: ID}}
 *
 * Logica:
 *   1. Lee el pedido (el hijo creado por el divisor).
 *   2. Si tiene tag "origen-<n>", va al pedido ORIGINAL (ahi estan los kits completos).
 *      Ojo: dividir.js escribe el NUMERO sin almohadilla ('origen-' + name.replace('#','')),
 *      p.ej. "origen-1229". Se resuelve por nombre; se acepta un ID por si cambia.
 *   3. Si el producto vino dentro de un kit (lineItemGroup) -> resena del KIT; si no -> del producto.
 *   4. Respaldo: ficha del producto por su ID; si tampoco -> inicio.
 *   Destino: anatomicq.com/products/<handle>#judgeme_product_reviews
 *
 * Env (Vercel): SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET, las mismas que usa
 * /api/dividir (app "Editor claude", trae read_orders y read_products).
 */
const STORE = 'xx0kf5-dk.myshopify.com';
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API = '2025-01';
const TIENDA = 'https://anatomicq.com';

// Mismo helper que /api/dividir: client_credentials con la app de scopes amplios.
let TOKEN = null;
async function getToken() {
  if (TOKEN) return TOKEN;
  const r = await fetch(`https://${STORE}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'client_credentials' }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('No token: ' + JSON.stringify(j).slice(0, 200));
  TOKEN = j.access_token; return TOKEN;
}

async function gql(query, variables) {
  const res = await fetch(`https://${STORE}/admin/api/${API}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await getToken() },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors) throw new Error('GraphQL: ' + JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

const ORDER_FIELDS = `
  id name tags
  lineItems(first: 50) {
    nodes {
      product { id handle }
      lineItemGroup { productId title }
    }
  }`;

const esId = (v) => /^\d{10,}$/.test(String(v));

async function pedidoPorId(id) {
  const d = await gql(`query($id: ID!){ order(id: $id){ ${ORDER_FIELDS} } }`, { id: `gid://shopify/Order/${id}` });
  return d.order;
}

async function pedidoPorNombre(n) {
  const nombre = String(n).replace(/^#/, '');
  const d = await gql(`query($q: String!){ orders(first: 1, query: $q){ nodes { ${ORDER_FIELDS} } } }`, { q: `name:#${nombre}` });
  return d.orders.nodes[0] || null;
}

async function handlePorProductoId(pid) {
  const d = await gql(`query($id: ID!){ product(id: $id){ handle status } }`, { id: `gid://shopify/Product/${pid}` });
  return d.product && d.product.status === 'ACTIVE' ? d.product.handle : null;
}

async function resolver(orderId, productId) {
  let pedido = null;

  if (orderId) {
    pedido = esId(orderId) ? await pedidoPorId(orderId) : await pedidoPorNombre(orderId);
    const origen = pedido && pedido.tags.map(t => /^origen-(.+)$/i.exec(t)).find(Boolean);
    if (origen) {
      const ref = origen[1];
      const original = esId(ref) ? await pedidoPorId(ref) : await pedidoPorNombre(ref);
      if (original) pedido = original;
    }
  }

  if (pedido) {
    const pgid = productId ? `gid://shopify/Product/${productId}` : null;
    const lineas = pedido.lineItems.nodes;
    const linea = (pgid && lineas.find(l => l.product && l.product.id === pgid)) || lineas[0];

    if (linea && linea.lineItemGroup && linea.lineItemGroup.productId) {
      const pid = linea.lineItemGroup.productId.split('/').pop();
      const h = await handlePorProductoId(pid);
      if (h) return { handle: h, tipo: 'kit', pedido: pedido.name };
    }
    if (linea && linea.product && linea.product.handle) {
      return { handle: linea.product.handle, tipo: 'producto', pedido: pedido.name };
    }
  }

  if (productId) {
    const h = await handlePorProductoId(productId);
    if (h) return { handle: h, tipo: 'producto-respaldo', pedido: null };
  }
  return null;
}

export default async function handler(req, res) {
  const raw = String(req.query.d || '');
  let txt = raw;
  try { txt = decodeURIComponent(raw); } catch (_) {}
  const [a = '', b = ''] = txt.split('-');
  const orderId = a.replace(/[^\w#]/g, '');
  const productId = b.replace(/\D/g, '');

  let destino = TIENDA;
  let info = null;
  try {
    info = await resolver(orderId, productId);
    if (info) destino = `${TIENDA}/products/${encodeURIComponent(info.handle)}#judgeme_product_reviews`;
  } catch (e) {
    console.error('resena error', e.message);
  }

  console.log(JSON.stringify({ evento: 'resena', raw, orderId, productId, ...info, destino }));
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 302;
  res.setHeader('Location', destino);
  res.end();
}
