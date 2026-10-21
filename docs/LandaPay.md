landapay
TypeScript icon, indicating that this package has built-in type declarations
1.0.1 • Public • Published 4 hours ago
landapay
Librería oficial de Landa Pay para Node.js. Crea links de pago y suscripciones, consulta pagos y verifica webhooks con tipos de TypeScript, reintentos automáticos e idempotencia incluida.

Documentación completa: docs.landapay.co

Instalación
Configuración
Uso rápido
Links de pago
Suscripciones
Planes, clientes y pagos
Webhooks
Errores
Idempotencia y reintentos
Desarrollo local
Instalación
npm install landapay
Requiere Node.js 18 o superior. Funciona con ESM, CommonJS y TypeScript (los tipos vienen incluidos).

Configuración
La librería lee su configuración de variables de entorno:

Variable	Para qué sirve
LANDAPAY_API_KEY	API key secreta (lp_sk_test_... o lp_sk_live_...). Obligatoria
LANDAPAY_WEBHOOK_SECRET	Secreto de firma de tus webhooks (whsec_...)
LANDAPAY_API_URL	URL de la API. Por defecto https://api.landapay.co
LANDAPAY_TIMEOUT	Tiempo máximo por petición en ms. Por defecto 30000
LANDAPAY_MAX_RETRIES	Reintentos ante errores de red, 429 y 5xx. Por defecto 2
# .env
LANDAPAY_API_KEY=lp_sk_test_...
LANDAPAY_WEBHOOK_SECRET=whsec_...
Usa la API key solo en tu servidor. Nunca la incluyas en el navegador ni en una app móvil.

Uso rápido
landapay es una instancia lista que lee las variables la primera vez que haces una llamada:

import "dotenv/config";
import { landapay } from "landapay";

const link = await landapay.paymentLinks.create({
  title: "Pedido A-1001",
  amount: 15_000_000, // centavos: $150.000 COP
});

console.log(link.url);
Si prefieres pasar la configuración en código, o manejas varias llaves, crea tu propio cliente:

import Landapay from "landapay";

const landapay = new Landapay({
  apiKey: process.env.MI_LLAVE,
  timeout: 10_000,
  maxRetries: 3,
});
Con CommonJS:

const { landapay, Landapay } = require("landapay");
Links de pago
const link = await landapay.paymentLinks.create({
  title: "Pedido A-1001",
  amount: 15_000_000,
  currency: "COP", // por defecto
  expiresAt: "2026-12-31T23:59:59", // sin zona horaria = hora de Colombia
  paymentMethods: { pse: false },
  redirectUrl: "https://tutienda.com/pago/resultado",
  metadata: { orderId: "A-1001" },
});

await landapay.paymentLinks.retrieve(link.id);
await landapay.paymentLinks.update(link.id, { amount: 12_000_000 });
await landapay.paymentLinks.disable(link.id);
await landapay.paymentLinks.enable(link.id);
Al volver del checkout, confirma el pago antes de entregar el pedido:

const payment = await landapay.payments.retrieve(String(req.query.payment_id));
if (payment.status === "approved") {
  // Entregar el pedido
}
Si sigue en pending, payments.watch lo vuelve a consultar cada 3 segundos hasta que cambie, se agote la espera (60 segundos, o 180 si es Nequi) o abortes con signal. Cada cambio llega al for await. Guárdalo en el estado de React para actualizar el comprobante sin recargar:

app.get("/pago/:id/stream", async (req, res) => {
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  res.setHeader("Content-Type", "text/event-stream");

  for await (const payment of landapay.payments.watch(String(req.params.id), {
    signal: controller.signal,
  })) {
    res.write(`data: ${JSON.stringify(payment)}\n\n`);
  }
});
useEffect(() => {
  const source = new EventSource(`/pago/${paymentId}/stream`);
  source.onmessage = (event) => setPayment(JSON.parse(event.data));
  return () => source.close();
}, [paymentId]);
Suscripciones
subscriptions.create devuelve la URL del checkout donde el cliente registra su método de pago. La suscripción se crea cuando lo completa y te llega con el webhook subscription.created.

Con el plan definido en la misma llamada (no hace falta crearlo antes):

const { checkoutUrl, plan, customer } = await landapay.subscriptions.create({
  plan: {
    name: "Licencia Pro - 5 usuarios", // opcional
    interval: "monthly", // weekly | quincenal | monthly | quarterly | semiannual | annual
    amount: 4_990_000,
    trialDays: 14,
  },
  customer: { name: "María Gómez", email: "maria@example.com" }, // se reutiliza si ya existe
  externalId: "license_8812",
  metadata: { seats: 5 },
  redirectUrl: "https://tuapp.com/suscripcion",
});
Con un plan y un cliente existentes:

const { checkoutUrl } = await landapay.subscriptions.create({
  plan: "plan_PLANCODE23456789",
  customer: "cus_ABCDEFGHJKLMNPQR",
});
Precios por etapas y número de cobros:

await landapay.subscriptions.create({
  plan: {
    interval: "monthly",
    termCycleCount: 12,
    phases: [
      {
        type: "priced",
        amount: 1_990_000,
        duration: { unit: "month", count: 3 },
      },
      { type: "priced", amount: 4_990_000 },
    ],
  },
});
Gestionar la suscripción:

const subscription = await landapay.subscriptions.retrieve("sub_...");
const checkout = await landapay.subscriptions.retrieveCheckout("scs_...");

await landapay.subscriptions.update("sub_...", { metadata: { seats: 10 } });
await landapay.subscriptions.cancel("sub_..."); // al final del periodo pagado
await landapay.subscriptions.cancel("sub_...", {
  atPeriodEnd: false,
  reason: "Pedido del usuario",
});
await landapay.subscriptions.resume("sub_...");
Planes, clientes y pagos
// Planes reutilizables
const plan = await landapay.plans.create({
  name: "Plan Pro",
  interval: "monthly",
  amount: 4_990_000,
});
await landapay.plans.retrieve(plan.id);
await landapay.plans.update(plan.id, { amount: 5_990_000 });
await landapay.plans.delete(plan.id);

// Clientes
const customer = await landapay.customers.create({
  name: "María Gómez",
  email: "maria@example.com",
});
await landapay.customers.retrieve(customer.id);
await landapay.customers.update(customer.id, { phone: "3001234567" });
const customerId = await landapay.customers.getOrCreateId({
  name: "María",
  email: "maria@example.com",
});

// Pagos
const payment = await landapay.payments.retrieve("pay_...");
Webhooks
Registra el endpoint en el panel (Desarrolladores › Webhooks) y guarda su secreto en LANDAPAY_WEBHOOK_SECRET. constructEvent verifica la firma Landa-Signature y devuelve el evento tipado. Pásale el cuerpo crudo:

import express from "express";
import { SignatureVerificationError, landapay } from "landapay";

const app = express();

app.post(
  "/webhooks/landapay",
  express.raw({ type: "application/json" }),
  (req, res) => {
    let event;
    try {
      event = landapay.webhooks.constructEvent(
        req.body,
        req.get("Landa-Signature"),
      );
    } catch (error) {
      if (error instanceof SignatureVerificationError)
        return res.status(400).send(error.message);
      throw error;
    }

    switch (event.type) {
      case "payment.approved":
        // event.data.object es un Payment
        break;
      case "subscription.created":
        // event.data.object es una Subscription
        break;
    }
    res.sendStatus(200);
  },
);
Para probar tu endpoint sin un evento real, firma un cuerpo con landapay.webhooks.generateTestHeader(payload).

Errores
Todos los errores heredan de LandapayError y traen type, code, status, param, requestId y details.

Clase	Cuándo ocurre
InvalidRequestError	Parámetros inválidos, recurso inexistente o conflicto (400, 404, 409)
AuthenticationError	API key ausente, con formato inválido o revocada (401)
PermissionError	La operación exige una llave live (403)
IdempotencyError	Llave de idempotencia reutilizada con otros datos (409)
RateLimitError	Demasiadas peticiones (429)
ApiError	Error de Landa Pay (5xx)
ConnectionError	Sin conexión o tiempo agotado
SignatureVerificationError	Firma de webhook inválida o vencida
import { InvalidRequestError, LandapayError } from "landapay";

try {
  await landapay.customers.create({
    name: "María",
    email: "maria@example.com",
  });
} catch (error) {
  if (error instanceof InvalidRequestError && error.code === "email_taken") {
    console.log("Ya existe:", error.details.existingId);
  } else if (error instanceof LandapayError) {
    console.error(error.code, error.message, error.requestId);
  }
}
Idempotencia y reintentos
Cada creación lleva una Idempotency-Key automática; los reintentos usan la misma, así que nunca crean duplicados.
Los errores de red, 429 y 5xx se reintentan con espera creciente y respetando Retry-After.
Puedes enviar tu propia llave y ajustar el tiempo de espera por llamada:
await landapay.paymentLinks.create(
  { title: "Pedido A-1001", amount: 15_000_000 },
  { idempotencyKey: "link-A-1001", timeout: 5_000, maxRetries: 0 },
);
Desarrollo local
Para apuntar a un api local en lugar de api.landapay.co:

LANDAPAY_API_URL=http://localhost:3001