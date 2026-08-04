export default async function handler(req, res) {
  const { code, shop, hmac } = req.query;

  const client_id = process.env.SHOPIFY_CLIENT_ID;
  const client_secret = process.env.SHOPIFY_CLIENT_SECRET;
  const scopes = 'read_orders,write_orders,read_fulfillments,write_fulfillments';
  const redirect_uri = 'https://anatomicq-dropi-splitter.vercel.app/api/auth';

  // Paso 1: redirigir a Shopify para autorizar
  if (!code) {
    const authUrl = `https://xx0kf5-dk.myshopify.com/admin/oauth/authorize?client_id=${client_id}&scope=${scopes}&redirect_uri=${redirect_uri}`;
    return res.redirect(authUrl);
  }

  // Paso 2: intercambiar code por token
  const response = await fetch(`https://xx0kf5-dk.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id, client_secret, code }),
  });

  const data = await response.json();
  console.log('ACCESS TOKEN:', data.access_token);

  return res.status(200).send(`Tu token es: ${data.access_token}`);
}
