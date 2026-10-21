import { config as loadEnv } from 'dotenv'
import cors from 'cors'
import express from 'express'
import { cert, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Landapay, { LandapayError, SignatureVerificationError } from 'landapay'
import type { Payment } from 'landapay'

const here = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(here, '../.env') })
loadEnv()

function initAdmin() {
  if (getApps().length) return
  const candidates = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    resolve(here, '../serviceAccount.json'),
    resolve(process.cwd(), 'serviceAccount.json')
  ].filter(Boolean) as string[]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    initializeApp({ credential: cert(JSON.parse(readFileSync(path, 'utf8'))) })
    return
  }
  initializeApp()
}

initAdmin()
const db = getFirestore()
const auth = getAuth()

const PLAN_CODE = 'cashpro'
const MONTHLY_AMOUNT_COP = 20_000

type PlanPeriod = 'monthly' | 'semester' | 'annual'
type UnknownRecord = Record<string, unknown>

const PLANS: Record<PlanPeriod, { title: string; amountCop: number; amountCents: number; months: number }> = {
  monthly: { title: 'Mensual', amountCop: MONTHLY_AMOUNT_COP, amountCents: MONTHLY_AMOUNT_COP * 100, months: 1 },
  semester: { title: 'Semestral', amountCop: 81_000, amountCents: 81_000 * 100, months: 6 },
  annual: { title: 'Anual', amountCop: 144_000, amountCents: 144_000 * 100, months: 12 }
}

function landa() {
  const apiKey = String(process.env.LANDAPAY_API_KEY || '').trim()
  if (!apiKey) throw new Error('Falta LANDAPAY_API_KEY en el servidor')
  return new Landapay({
    apiKey,
    webhookSecret: String(process.env.LANDAPAY_WEBHOOK_SECRET || '').trim() || undefined
  })
}

function parsePeriod(value: unknown): PlanPeriod {
  const p = String(value || '').toLowerCase()
  if (p === 'semester' || p === 'annual') return p
  return 'monthly'
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' ? (value as UnknownRecord) : {}
}

function pickString(...values: unknown[]) {
  for (const value of values) {
    const text = String(value || '').trim()
    if (text) return text
  }
  return ''
}

function addMonths(fromMs: number, months: number) {
  const d = new Date(fromMs)
  d.setMonth(d.getMonth() + months)
  return d.getTime()
}

function json(res: express.Response, status: number, body: unknown) {
  res.status(status).json(body)
}

function bearerToken(req: express.Request) {
  const header = String(req.get('authorization') || req.get('Authorization') || '')
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

async function requireUid(req: express.Request) {
  const token = bearerToken(req)
  if (!token) {
    const err = new Error('Sin sesión') as Error & { status: number }
    err.status = 401
    throw err
  }
  try {
    const decoded = await auth.verifyIdToken(token)
    return decoded.uid
  } catch {
    const err = new Error('Sesión inválida') as Error & { status: number }
    err.status = 401
    throw err
  }
}

function pesosFromCents(cents: number, fallback: number) {
  if (cents >= 100_000) return Math.round(cents / 100)
  if (cents > 0) return cents
  return fallback
}

async function activateCashPro(payload: {
  uid: string
  period: PlanPeriod
  paymentId: string
  amountCop: number
  customerId?: string
  paymentLinkId?: string
}) {
  if (!payload.uid || !payload.paymentId) return null

  const userRef = db.doc(`users/${payload.uid}`)
  const paymentRef = userRef.collection('subscription_payments').doc(payload.paymentId)

  return db.runTransaction(async (tx) => {
    const existingPay = await tx.get(paymentRef)
    const snap = await tx.get(userRef)
    if (existingPay.exists) return asRecord(snap.data()?.subscription)

    const current = asRecord(snap.data()?.subscription)
    const now = Date.now()
    const fromMs = Math.max(Number(current.currentPeriodEndMs || 0), now)
    const plan = PLANS[payload.period]
    const periodEndMs = addMonths(fromMs, plan.months)
    const amountCop = payload.amountCop || plan.amountCop

    const subscription = {
      planCode: PLAN_CODE,
      status: 'active',
      billingPeriod: payload.period,
      currentPeriodEndMs: periodEndMs,
      monthlyAmountCop: MONTHLY_AMOUNT_COP,
      currentAmountCop: amountCop,
      landaCustomerId: payload.customerId || current.landaCustomerId || '',
      landaPaymentLinkId: payload.paymentLinkId || current.landaPaymentLinkId || '',
      lastPaymentId: payload.paymentId,
      lastPaidAtMs: now,
      provider: 'landapay'
    }

    tx.set(userRef, { subscription, updatedAtMs: now }, { merge: true })
    tx.set(paymentRef, {
      transactionId: payload.paymentId,
      billingPeriod: payload.period,
      amountCop,
      paidAtMs: now,
      provider: 'landapay',
      landaCustomerId: payload.customerId || '',
      landaPaymentLinkId: payload.paymentLinkId || ''
    })
    return subscription
  })
}

async function uidFromCustomer(customerId: string) {
  if (!customerId) return ''
  try {
    const customer = await landa().customers.retrieve(customerId)
    return pickString(customer.externalId, asRecord(customer.metadata).uid)
  } catch {
    const found = await db.collection('users').where('subscription.landaCustomerId', '==', customerId).limit(1).get()
    return found.empty ? '' : found.docs[0]!.id
  }
}

async function contextFromPayment(payment: Payment) {
  let uid = ''
  let period: PlanPeriod = 'monthly'
  let periodFromLink = false
  const paymentLinkId = pickString(payment.paymentLink)

  if (paymentLinkId) {
    try {
      const link = await landa().paymentLinks.retrieve(paymentLinkId)
      const meta = asRecord(link.metadata)
      uid = pickString(meta.uid)
      if (meta.billingPeriod) {
        period = parsePeriod(meta.billingPeriod)
        periodFromLink = true
      }
    } catch {
      /* confirmamos con el cliente */
    }
  }

  if (!uid) uid = await uidFromCustomer(pickString(payment.customer))
  if (uid && !periodFromLink) {
    const stored = asRecord((await db.doc(`users/${uid}`).get()).data()?.subscription)
    period = parsePeriod(stored.pendingBillingPeriod || stored.billingPeriod || period)
  }

  return {
    uid,
    period,
    paymentLinkId,
    customerId: pickString(payment.customer),
    amountCop: pesosFromCents(Number(payment.amountCop || payment.amount || 0), PLANS[period].amountCop)
  }
}

async function activateFromPayment(payment: Payment) {
  if (payment.status !== 'approved') return null
  const ctx = await contextFromPayment(payment)
  if (!ctx.uid) {
    console.error('[paymatu] pago aprobado sin uid', payment.id)
    return null
  }
  return activateCashPro({
    uid: ctx.uid,
    period: ctx.period,
    paymentId: payment.id,
    amountCop: ctx.amountCop,
    customerId: ctx.customerId,
    paymentLinkId: ctx.paymentLinkId
  })
}

async function ensurePendingUser(
  uid: string,
  payload: { email: string; fullName: string; phone: string; period: PlanPeriod }
) {
  const ref = db.doc(`users/${uid}`)
  const snap = await ref.get()
  const plan = PLANS[payload.period]
  const pending = {
    planCode: PLAN_CODE,
    status: 'pending',
    billingPeriod: payload.period,
    currentPeriodEndMs: 0,
    monthlyAmountCop: MONTHLY_AMOUNT_COP,
    currentAmountCop: plan.amountCop,
    provider: 'landapay'
  }
  if (!snap.exists) {
    await ref.set({
      email: payload.email,
      fullName: payload.fullName,
      phone: payload.phone,
      createdAtMs: Date.now(),
      subscription: pending
    })
    return
  }
  const sub = asRecord(snap.data()?.subscription)
  const stillPaid =
    sub.status === 'active' && Number(sub.currentPeriodEndMs || 0) > Date.now() && sub.billingPeriod !== 'trial'
  if (stillPaid) return
  await ref.set(
    {
      email: payload.email || snap.data()?.email,
      fullName: payload.fullName || snap.data()?.fullName,
      phone: payload.phone || snap.data()?.phone,
      subscription: {
        ...pending,
        currentPeriodEndMs: Number(sub.currentPeriodEndMs || 0),
        landaCustomerId: sub.landaCustomerId || ''
      }
    },
    { merge: true }
  )
}

async function handleCheckout(req: express.Request, res: express.Response) {
  const uid = await requireUid(req)
  const body = asRecord(req.body)
  const period = parsePeriod(body.planPeriod || body.period)
  const plan = PLANS[period]
  const userRecord = await auth.getUser(uid)
  const profile = asRecord((await db.doc(`users/${uid}`).get()).data())

  const email = pickString(userRecord.email, body.email, profile.email).toLowerCase()
  const fullName = pickString(body.fullName, userRecord.displayName, profile.fullName, email.split('@')[0])
  const phone = pickString(body.phone, profile.phone).replace(/\D/g, '').slice(-10)
  if (!email) {
    json(res, 400, { ok: false, error: 'El correo es obligatorio para crear el cliente en Landa Pay' })
    return
  }

  await ensurePendingUser(uid, { email, fullName, phone, period })

  const pay = landa()
  const stored = asRecord((await db.doc(`users/${uid}`).get()).data()?.subscription)
  let customerId = pickString(stored.landaCustomerId)

  if (!customerId) {
    try {
      customerId = await pay.customers.getOrCreateId({
        name: fullName,
        email,
        externalId: uid,
        metadata: { uid, app: 'matucash' },
        ...(phone ? { phone } : {})
      })
    } catch (error) {
      if (error instanceof LandapayError && (error.code === 'email_taken' || error.code === 'external_id_taken')) {
        customerId = pickString(asRecord(error.details).existingId)
      } else {
        throw error
      }
    }
  }

  if (customerId) {
    try {
      await pay.customers.update(customerId, {
        name: fullName,
        externalId: uid,
        metadata: { uid, app: 'matucash' },
        ...(phone ? { phone } : {})
      })
    } catch {
      /* el link se crea igual */
    }
  }

  const redirectUrl = pickString(body.redirectUrl) || 'https://matucash.com/billing/return'
  const link = await pay.paymentLinks.create(
    {
      title: `CashPro ${plan.title} — MatuCash`,
      description: `Licencia ${plan.title.toLowerCase()} de MatuCash`,
      amount: plan.amountCents,
      currency: 'COP',
      redirectUrl,
      metadata: {
        uid,
        billingPeriod: period,
        app: 'matucash'
      }
    },
    { idempotencyKey: `cashpro_${uid}_${period}_${Date.now()}` }
  )

  await db.doc(`users/${uid}`).set(
    {
      subscription: {
        landaCustomerId: customerId,
        landaPaymentLinkId: link.id,
        pendingBillingPeriod: period,
        provider: 'landapay'
      }
    },
    { merge: true }
  )

  json(res, 200, {
    ok: true,
    data: {
      checkoutUrl: link.url,
      period,
      amountInCents: plan.amountCents,
      currency: 'COP',
      customerId,
      linkId: link.id
    }
  })
}

async function handleConfirm(req: express.Request, res: express.Response) {
  const uid = await requireUid(req)
  const body = asRecord(req.body)
  const paymentId = pickString(body.paymentId, body.payment_id, body.transactionId, body.id)
  if (!paymentId) {
    json(res, 400, { ok: false, error: 'payment_id es requerido' })
    return
  }

  const payment = await landa().payments.retrieve(paymentId)
  if (payment.status !== 'approved') {
    json(res, 200, {
      ok: true,
      data: {
        transactionStatus: payment.status.toUpperCase(),
        subscription: { status: 'past_due' }
      }
    })
    return
  }

  const ctx = await contextFromPayment(payment)
  if (ctx.uid && ctx.uid !== uid) {
    json(res, 403, { ok: false, error: 'Este pago no corresponde a tu cuenta' })
    return
  }

  const subscription = await activateCashPro({
    uid,
    period: ctx.period,
    paymentId: payment.id,
    amountCop: ctx.amountCop,
    customerId: ctx.customerId,
    paymentLinkId: ctx.paymentLinkId
  })

  json(res, 200, {
    ok: true,
    data: {
      transactionStatus: 'APPROVED',
      subscription: {
        status: String(subscription?.status || 'active'),
        periodEndMs: Number(subscription?.currentPeriodEndMs || 0)
      }
    }
  })
}

function rawBody(req: express.Request) {
  const raw = (req as express.Request & { rawBody?: Buffer }).rawBody
  if (Buffer.isBuffer(raw)) return raw
  if (Buffer.isBuffer(req.body)) return req.body
  if (typeof req.body === 'string') return Buffer.from(req.body)
  return Buffer.from(JSON.stringify(req.body || {}))
}

async function handleWebhook(req: express.Request, res: express.Response) {
  const pay = landa()
  let event
  try {
    event = pay.webhooks.constructEvent(rawBody(req), req.get('Landa-Signature') || '')
  } catch (error) {
    if (error instanceof SignatureVerificationError) {
      res.status(400).send(error.message)
      return
    }
    throw error
  }

  const eventRef = db.doc(`billing_events/${event.id}`)
  const already = await eventRef.get()
  if (already.exists) {
    res.sendStatus(200)
    return
  }

  if (event.type === 'payment.approved') {
    await activateFromPayment(event.data.object)
  }

  await eventRef.set({
    type: event.type,
    createdAt: event.createdAt,
    receivedAtMs: Date.now()
  })
  res.sendStatus(200)
}

function wrap(handler: (req: express.Request, res: express.Response) => Promise<void>) {
  return (req: express.Request, res: express.Response) => {
    void handler(req, res).catch((error: unknown) => {
      const status = Number((error as { status?: number })?.status || 500)
      const message =
        error instanceof LandapayError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Error interno'
      if (status >= 500) {
        console.error('[paymatu]', message, error instanceof LandapayError ? error.requestId : error)
      }
      if (!res.headersSent) json(res, status >= 400 && status < 600 ? status : 500, { ok: false, error: message })
    })
  }
}

const allowedOrigins = String(
  process.env.CORS_ORIGINS ||
    'https://matucash.com,https://www.matucash.com,https://matucash.web.app,http://localhost:5173,http://localhost:5174'
)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

const app = express()
app.set('trust proxy', 1)
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true)
        return
      }
      callback(new Error('Origen no permitido'))
    },
    credentials: true
  })
)
app.post('/webhooks/landapay', express.raw({ type: 'application/json' }), wrap(handleWebhook))
app.post('/api/webhooks/landapay', express.raw({ type: 'application/json' }), wrap(handleWebhook))
app.use(express.json({ limit: '1mb' }))
app.post('/billing/checkout', wrap(handleCheckout))
app.post('/api/billing/checkout', wrap(handleCheckout))
app.post('/billing/confirm', wrap(handleConfirm))
app.post('/api/billing/confirm', wrap(handleConfirm))
app.get('/health', (_req, res) => json(res, 200, { ok: true, service: 'paymatu' }))
app.get('/api/billing/health', (_req, res) => json(res, 200, { ok: true, service: 'paymatu' }))
app.use((_req, res) => json(res, 404, { ok: false, error: 'Ruta no encontrada' }))

const port = Number(process.env.PORT || 8787)
const host = String(process.env.HOST || '127.0.0.1')
app.listen(port, host, () => {
  console.log(`[paymatu] Landa Pay listo en http://${host}:${port}`)
})
