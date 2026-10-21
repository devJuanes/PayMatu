# PayMatu

API de cobro de MatuCash. Habla con Landa Pay (llave secreta) y activa la licencia en Firestore. El front nunca ve `LANDAPAY_API_KEY`.

## Local

1. Copia `.env.example` a `.env` y pega la API key de Landa Pay.
2. Copia `serviceAccount.json` del proyecto Firebase `matu-catalogo`.
3. Instala y arranca:

```bash
npm install
npm run dev
```

Health: http://127.0.0.1:8787/api/billing/health

MatuCash en local puede seguir usando el proxy de Vite (`/api` → puerto 8787).

## Servidor (Nginx + PM2)

En el VPS (Ubuntu), con Node 20:

```bash
sudo mkdir -p /var/www/paymatu
sudo chown $USER:$USER /var/www/paymatu
# sube el repo a esa carpeta (git clone o scp)

cd /var/www/paymatu
cp .env.example .env
nano .env
# LANDAPAY_API_KEY, LANDAPAY_WEBHOOK_SECRET, GOOGLE_APPLICATION_CREDENTIALS=/var/www/paymatu/serviceAccount.json

# sube también serviceAccount.json (no lo subas a git)

npm install --omit=dev
npm run build

sudo npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Nginx — sitio nuevo `pay.matubyte.com`:

```bash
sudo cp deploy/nginx-paymatu.conf /etc/nginx/sites-available/paymatu
sudo ln -s /etc/nginx/sites-available/paymatu /etc/nginx/sites-enabled/paymatu
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d pay.matubyte.com
```

Si prefieres reutilizar `cashapi.matubyte.com`, pega el contenido de `deploy/nginx-cashapi-snippet.conf` en ese `server`.

## Landa Pay (panel)

Webhook HTTPS:

`https://pay.matubyte.com/api/webhooks/landapay`

(o `https://cashapi.matubyte.com/api/webhooks/landapay` si usas el snippet).

## MatuCash

En el `.env` del front, antes de `npm run build` / deploy hosting:

```
VITE_BILLING_API_URL=https://pay.matubyte.com
```

Rutas:

- `POST /api/billing/checkout` — crea el link y devuelve `checkoutUrl`
- `POST /api/billing/confirm` — confirma `payment_id` y activa CashPro
- `POST /api/webhooks/landapay` — `payment.approved`
