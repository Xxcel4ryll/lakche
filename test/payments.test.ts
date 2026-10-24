import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  type Effect,
  type Order,
  type PaymentEvent,
  type SplitConfig,
  applyPaymentEvent,
  computeSplit,
  verifySignature,
} from '../src/payments.js';

// --- 3a ---------------------------------------------------------------------------------------

const SECRET = 'whsec_test_123';
const body = Buffer.from('{"reference":"ord-1","status":"SUCCESS","amount":5000}');
const sign = (raw: Buffer, secret = SECRET) => createHmac('sha256', secret).update(raw).digest('hex');

test('verifySignature accepts the HMAC of the raw body, in either hex case', () => {
  assert.equal(verifySignature(body, sign(body), SECRET), true);
  assert.equal(verifySignature(body, sign(body).toUpperCase(), SECRET), true);
});

test('verifySignature rejects a tampered or re-serialised body and a wrong secret', () => {
  const sig = sign(body);
  assert.equal(verifySignature(Buffer.from(body.toString().replace('5000', '50')), sig, SECRET), false);
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
  assert.equal(verifySignature(reserialised, sig, SECRET), false);
  assert.equal(verifySignature(body, sig, 'another-secret'), false);
});

test('verifySignature rejects malformed signatures without throwing', () => {
  const sig = sign(body);
  for (const bad of ['', sig.slice(0, 62), `${sig}00`, `${sig.slice(0, 63)}z`, `sha256=${sig}`]) {
    assert.equal(verifySignature(body, bad, SECRET), false, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(verifySignature(body, undefined as unknown as string, SECRET), false);
  assert.equal(verifySignature(body, sig, ''), false);
});

// --- 3b ---------------------------------------------------------------------------------------

const order = (overrides: Partial<Order> = {}): Order => ({
  reference: 'ord-1',
  userId: 'user-1',
  planId: 'plan-weekly',
  kitId: 'kx-kit-0007',
  amountMinor: 5000n,
  currency: 'XAF',
  status: 'PENDING',
  providerTxnIds: [],
  ...overrides,
});

const event = (overrides: Partial<PaymentEvent> = {}): PaymentEvent => ({
  providerTxnId: 'txn-1',
  reference: 'ord-1',
  status: 'SUCCESS',
  amountMinor: 5000n,
  currency: 'XAF',
  ...overrides,
});

const ACTIVATE_AND_CREDIT: Effect[] = [
  { type: 'ACTIVATE_SUBSCRIPTION', orderRef: 'ord-1' },
  { type: 'CREDIT_REVENUE', orderRef: 'ord-1' },
];

test('a successful payment activates and credits once; its retries add nothing', () => {
  const first = applyPaymentEvent(order(), event());
  assert.equal(first.order.status, 'PAID');
  assert.deepEqual(first.order.providerTxnIds, ['txn-1']);
  assert.deepEqual(first.effects, ACTIVATE_AND_CREDIT);

  let current = first.order;
  for (let retry = 0; retry < 5; retry++) {
    const again = applyPaymentEvent(current, event());
    assert.deepEqual(again.effects, []);
    assert.deepEqual(again.order, first.order);
    current = again.order;
  }
});

test('PENDING changes nothing, and does not block a SUCCESS with the same txn id', () => {
  const pending = applyPaymentEvent(order(), event({ status: 'PENDING' }));
  assert.deepEqual(pending, { order: order(), effects: [] });
  const success = applyPaymentEvent(pending.order, event());
  assert.deepEqual(success.effects, ACTIVATE_AND_CREDIT);
});

test('a late FAILED never undoes a PAID order', () => {
  const paid = applyPaymentEvent(order(), event()).order;
  const late = applyPaymentEvent(paid, event({ providerTxnId: 'txn-0', status: 'FAILED' }));
  assert.equal(late.order.status, 'PAID');
  assert.deepEqual(late.effects, []);
});

test('FAILED marks a pending order failed; a later SUCCESS still activates it', () => {
  const failed = applyPaymentEvent(order(), event({ providerTxnId: 'txn-1', status: 'FAILED' }));
  assert.equal(failed.order.status, 'FAILED');
  assert.deepEqual(failed.effects, []);
  const retried = applyPaymentEvent(failed.order, event({ providerTxnId: 'txn-2' }));
  assert.equal(retried.order.status, 'PAID');
  assert.deepEqual(retried.effects, ACTIVATE_AND_CREDIT);
});

test('an amount or currency mismatch is flagged and never activated', () => {
  for (const ev of [event({ amountMinor: 500n }), event({ currency: 'XOF' })]) {
    const result = applyPaymentEvent(order(), ev);
    assert.equal(result.order.status, 'PENDING');
    assert.equal(result.effects.length, 1);
    assert.equal(result.effects[0].type, 'FLAG_FOR_REVIEW');
    // The provider retries the same event: flagged once only.
    assert.deepEqual(applyPaymentEvent(result.order, ev).effects, []);
  }
});

test('a second distinct successful payment for a paid order is flagged, not activated again', () => {
  const paid = applyPaymentEvent(order(), event()).order;
  const second = applyPaymentEvent(paid, event({ providerTxnId: 'txn-2' }));
  assert.equal(second.order.status, 'PAID');
  assert.deepEqual(second.effects.map((e) => e.type), ['FLAG_FOR_REVIEW']);
});

test('out-of-order, retried deliveries activate exactly once', () => {
  const deliveries = [
    event({ status: 'SUCCESS' }),
    event({ status: 'PENDING' }),
    event({ status: 'SUCCESS' }),
    event({ providerTxnId: 'txn-0', status: 'FAILED' }),
    event({ status: 'SUCCESS' }),
    event({ providerTxnId: 'txn-0', status: 'FAILED' }),
  ];
  let current = order();
  const effects: Effect[] = [];
  for (const ev of deliveries) {
    const result = applyPaymentEvent(current, ev);
    current = result.order;
    effects.push(...result.effects);
  }
  assert.equal(current.status, 'PAID');
  assert.deepEqual(effects, ACTIVATE_AND_CREDIT);
});

test('applyPaymentEvent does not mutate its input and rejects an event for another order', () => {
  const original = order();
  const snapshot = structuredClone(original);
  applyPaymentEvent(original, event());
  assert.deepEqual(original, snapshot);
  assert.throws(() => applyPaymentEvent(original, event({ reference: 'ord-2' })));
});

// --- 3c ---------------------------------------------------------------------------------------

const cfg: SplitConfig = {
  vatEnabled: true,
  vatBps: 1925,
  acquisitionBps: 1000,
  servicePoolBps: 5000,
  companyBps: 3000,
  treasuryBps: 1000,
};

const sum = (r: ReturnType<typeof computeSplit>) => r.vat + r.acquisition + r.servicePool + r.company + r.treasury;

test('5000 XAF with VAT at 19.25%', () => {
  // vat = 5000 * 1925 / 11925 = 807.13 -> 807, net = 4193
  // acquisition 419.3 -> 419, service pool 2096.5 -> 2096, treasury 419.3 -> 419, company takes the rest
  const split = computeSplit(5000n, cfg);
  assert.deepEqual(split, { vat: 807n, acquisition: 419n, servicePool: 2096n, company: 1259n, treasury: 419n });
  assert.equal(sum(split), 5000n);
});

test('VAT disabled splits the whole gross', () => {
  assert.deepEqual(computeSplit(5000n, { ...cfg, vatEnabled: false }), {
    vat: 0n, acquisition: 500n, servicePool: 2500n, company: 1500n, treasury: 500n,
  });
});

test('parts plus VAT always add up to the gross amount', () => {
  for (const vatBps of [0, 1, 1925, 2000, 10_000]) {
    for (let gross = 0n; gross <= 3000n; gross += 7n) {
      const split = computeSplit(gross, { ...cfg, vatBps, servicePoolBps: 3333, companyBps: 4667 });
      assert.equal(sum(split), gross);
      for (const part of Object.values(split)) assert.ok(part >= 0n);
    }
  }
});

test('rejects configs whose shares do not total 10000 or contain invalid basis points', () => {
  assert.throws(() => computeSplit(5000n, { ...cfg, treasuryBps: 900 }), /total 10000/);
  assert.throws(() => computeSplit(5000n, { ...cfg, companyBps: 3000.5, treasuryBps: 999.5 }), RangeError);
  assert.throws(() => computeSplit(5000n, { ...cfg, acquisitionBps: -1000, companyBps: 5000 }), RangeError);
  assert.throws(() => computeSplit(5000n, { ...cfg, vatBps: -1 }), RangeError);
  assert.throws(() => computeSplit(-1n, cfg), RangeError);
});
