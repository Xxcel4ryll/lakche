import { createHmac, timingSafeEqual } from 'node:crypto';

export type OrderStatus = 'PENDING' | 'PAID' | 'FAILED';

export interface Order {
  reference: string;
  userId: string;
  planId: string;
  kitId: string;            // kit where the plan was sold
  amountMinor: bigint;
  currency: string;
  status: OrderStatus;
  providerTxnIds: string[]; // events already processed
}

export interface PaymentEvent {
  providerTxnId: string;
  reference: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  amountMinor: bigint;
  currency: string;
}

export type Effect =
  | { type: 'ACTIVATE_SUBSCRIPTION'; orderRef: string }
  | { type: 'CREDIT_REVENUE'; orderRef: string }
  | { type: 'FLAG_FOR_REVIEW'; orderRef: string; reason: string };

export interface SplitConfig {
  vatEnabled: boolean;
  vatBps: number;            // e.g. 1925 = 19.25%; prices are VAT-inclusive
  acquisitionBps: number;    // field: to the kit that sold the plan, e.g. 1000
  servicePoolBps: number;    // field: shared by data served, e.g. 5000
  companyBps: number;        // e.g. 3000
  treasuryBps: number;       // e.g. 1000
}

export interface SplitResult {
  vat: bigint; acquisition: bigint; servicePool: bigint; company: bigint; treasury: bigint;
}

// ---------------------------------------------------------------------------------------------
// 3a

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/**
 * `rawBody` must be the exact bytes received (e.g. express.raw()), not re-serialised JSON: any
 * change in whitespace or key order changes the HMAC.
 */
export function verifySignature(rawBody: Buffer, signatureHex: string, secret: string): boolean {
  // Buffer.from(s, 'hex') silently stops at the first invalid character, so check the format first.
  // That also guarantees equal lengths, which timingSafeEqual requires.
  if (!secret || typeof signatureHex !== 'string' || !SHA256_HEX.test(signatureHex)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signatureHex, 'hex'));
}

// ---------------------------------------------------------------------------------------------
// 3b

/**
 * Activation is tied to the transition into PAID, which can only happen once per order, so the
 * effects are emitted once. providerTxnIds also stops a retried event from being re-processed (and
 * re-flagged). The caller saves the returned order with a compare-and-set on the version it read
 * and writes the effects to an outbox in the same transaction, so two concurrent deliveries cannot
 * both win.
 */
export function applyPaymentEvent(order: Order, ev: PaymentEvent): { order: Order; effects: Effect[] } {
  if (ev.reference !== order.reference) {
    throw new Error(`event ${ev.providerTxnId} is for order ${ev.reference}, not ${order.reference}`);
  }
  if (order.providerTxnIds.includes(ev.providerTxnId)) return { order, effects: [] };
  // PENDING carries no decision. It is not recorded either, so a later SUCCESS that reuses the same
  // transaction id is not mistaken for a duplicate.
  if (ev.status === 'PENDING') return { order, effects: [] };

  const next: Order = { ...order, providerTxnIds: [...order.providerTxnIds, ev.providerTxnId] };
  const flag = (reason: string): { order: Order; effects: Effect[] } => ({
    order: next,
    effects: [{ type: 'FLAG_FOR_REVIEW', orderRef: order.reference, reason }],
  });

  if (ev.status === 'FAILED') {
    // A late FAILED (out of order, or a different failed attempt) never undoes a PAID order.
    if (order.status !== 'PAID') next.status = 'FAILED';
    return { order: next, effects: [] };
  }

  if (ev.amountMinor !== order.amountMinor || ev.currency !== order.currency) {
    return flag(`paid ${ev.amountMinor} ${ev.currency}, expected ${order.amountMinor} ${order.currency}`);
  }
  if (order.status === 'PAID') {
    // A different transaction succeeding for an order that is already paid: the customer was charged twice.
    return flag(`second successful payment ${ev.providerTxnId} for an order that is already paid`);
  }

  // From PENDING, or from FAILED: a success means the money moved, whatever arrived before it.
  next.status = 'PAID';
  return {
    order: next,
    effects: [
      { type: 'ACTIVATE_SUBSCRIPTION', orderRef: order.reference },
      { type: 'CREDIT_REVENUE', orderRef: order.reference },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// 3c

const BPS = 10_000n;

/**
 * Rounding:
 * - VAT is rounded half-up to the minor unit (commercial rounding, what a tax authority expects), and
 *   net = gross - vat, so VAT plus net always equals gross.
 * - Acquisition, service pool and treasury are rounded down, so no one is ever paid more than their
 *   configured share. Acquisition and the service pool go to operators, and an overpayment there
 *   could not be clawed back.
 * - Company takes net minus the other three. The remainder is at most 3 minor units per sale and lands
 *   in our own revenue line, where it creates no obligation to anyone and the books balance exactly.
 */
export function computeSplit(grossMinor: bigint, cfg: SplitConfig): SplitResult {
  if (grossMinor < 0n) throw new RangeError(`gross must not be negative, got ${grossMinor}`);
  const shares = [cfg.acquisitionBps, cfg.servicePoolBps, cfg.companyBps, cfg.treasuryBps];
  for (const bps of [cfg.vatBps, ...shares]) {
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      throw new RangeError(`basis points must be an integer from 0 to 10000, got ${bps}`);
    }
  }
  const total = shares.reduce((sum, bps) => sum + bps, 0);
  if (total !== 10_000) throw new RangeError(`shares must total 10000 bps, got ${total}`);

  // Prices include VAT: vat = gross * rate / (1 + rate).
  const vatBps = BigInt(cfg.vatBps);
  const vat = cfg.vatEnabled ? divRoundHalfUp(grossMinor * vatBps, BPS + vatBps) : 0n;
  const net = grossMinor - vat;

  const acquisition = (net * BigInt(cfg.acquisitionBps)) / BPS;
  const servicePool = (net * BigInt(cfg.servicePoolBps)) / BPS;
  const treasury = (net * BigInt(cfg.treasuryBps)) / BPS;
  const company = net - acquisition - servicePool - treasury;

  return { vat, acquisition, servicePool, company, treasury };
}

/** Rounds n / d half-up for n >= 0, d > 0. */
function divRoundHalfUp(n: bigint, d: bigint): bigint {
  return (2n * n + d) / (2n * d);
}
