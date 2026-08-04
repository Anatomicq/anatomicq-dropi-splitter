export default async function handler(req, res) {
  const { code, shop } = req.query;
  
  if (!code || !shop) {
    return res.status(400).send('Missing code or shop');
  }

  const client_id = process.env.SHOPIFY_CLIENT_ID;
  const client_secret = process.env.SHOPIFY_CLIENT_SECRET;

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id, client_secret, code }),
  });

  const data = await response.json();
  
  console.log('ACCESS TOKEN:', data.access_token);
  
  return res.status(200).send(`Token: ${data.access_token}`);
}
