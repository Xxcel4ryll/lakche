import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthorizeReply } from '../src/authorize.js';
import type { Kit, Plan, Subscription } from '../src/types.js';

const DAY_MS = 86_400_000;
const START = new Date('2026-03-02T08:00:00Z');

const kit = (nasType: Kit['nasType'] = 'mikrotik'): Kit => ({
  id: 'kx-kit-0007',
  nasType,
  operatorId: 'op-01',
  countryCode: 'CM',
});

const weeklyPlan: Plan = {
  id: 'plan-weekly',
  durationSeconds: 7 * 86_400,
  downKbps: 10_000,
  upKbps: 5_000,
  dataCapBytes: 20n * 1024n ** 3n,
  priceMinor: 5000n,
  currency: 'XAF',
};

const weeklySub = (overrides: Partial<Subscription> = {}): Subscription => ({
  id: 'sub-1',
  userId: 'user-1',
  planId: weeklyPlan.id,
  startsAt: START,
  expiresAt: new Date(START.getTime() + 7 * DAY_MS),
  revoked: false,
  bytesUsed: 0n,
  ...overrides,
});

const at = (ms: number) => new Date(START.getTime() + ms);

test('accepts a fresh weekly plan with the full duration and MikroTik rate limit', () => {
  assert.deepEqual(buildAuthorizeReply(kit(), weeklySub(), weeklyPlan, START), {
    result: 'accept',
    reply: {
      'Session-Timeout': 7 * 86_400,
      'Acct-Interim-Interval': 300,
      'Mikrotik-Rate-Limit': '5000k/10000k',
    },
  });
});

test('reconnects two days into a weekly plan only get the time left', () => {
  const first = buildAuthorizeReply(kit(), weeklySub(), weeklyPlan, at(2 * DAY_MS));
  assert.equal(first.result, 'accept');
  assert.equal(first.result === 'accept' && first.reply['Session-Timeout'], 5 * 86_400);

  // Another reconnect later the same day: the session still ends exactly at expiresAt.
  const offsetMs = 2 * DAY_MS + 3 * 3_600_000 + 17_250;
  const second = buildAuthorizeReply(kit(), weeklySub(), weeklyPlan, at(offsetMs));
  assert.equal(second.result === 'accept' && second.reply['Session-Timeout'], Math.floor((7 * DAY_MS - offsetMs) / 1000));
});

test('expiry boundary: last whole second accepts, anything less rejects', () => {
  const expiresMs = 7 * DAY_MS;

  const oneSecondLeft = buildAuthorizeReply(kit(), weeklySub(), weeklyPlan, at(expiresMs - 1000));
  assert.equal(oneSecondLeft.result === 'accept' && oneSecondLeft.reply['Session-Timeout'], 1);

  for (const ms of [expiresMs - 999, expiresMs, expiresMs + 1]) {
    assert.deepEqual(buildAuthorizeReply(kit(), weeklySub(), weeklyPlan, at(ms)), {
      result: 'reject',
      reason: 'subscription expired',
    });
  }
});

test('start boundary: rejects before startsAt, accepts at startsAt', () => {
  assert.deepEqual(buildAuthorizeReply(kit(), weeklySub(), weeklyPlan, at(-1)), {
    result: 'reject',
    reason: 'subscription not started yet',
  });
  assert.equal(buildAuthorizeReply(kit(), weeklySub(), weeklyPlan, START).result, 'accept');
});

test('chilli and omada get WISPr bandwidth in bits per second', () => {
  for (const nasType of ['chilli', 'omada'] as const) {
    assert.deepEqual(buildAuthorizeReply(kit(nasType), weeklySub(), weeklyPlan, START, 600), {
      result: 'accept',
      reply: {
        'Session-Timeout': 7 * 86_400,
        'Acct-Interim-Interval': 600,
        'WISPr-Bandwidth-Max-Up': 5_000_000,
        'WISPr-Bandwidth-Max-Down': 10_000_000,
      },
    });
  }
});

test('rejects unknown kit, missing or revoked subscription, and a mismatched plan', () => {
  const cases: [Parameters<typeof buildAuthorizeReply>, string][] = [
    [[undefined, weeklySub(), weeklyPlan, START], 'unknown kit'],
    [[kit(), undefined, weeklyPlan, START], 'no subscription for this user'],
    [[kit(), weeklySub({ revoked: true }), weeklyPlan, START], 'subscription revoked'],
    [[kit(), weeklySub(), undefined, START], 'plan not found for subscription'],
    [[kit(), weeklySub({ planId: 'plan-daily' }), weeklyPlan, START], 'plan not found for subscription'],
  ];
  for (const [args, reason] of cases) {
    assert.deepEqual(buildAuthorizeReply(...args), { result: 'reject', reason });
  }
});

test('rejects once the data cap is reached, accepts one byte below it', () => {
  const cap = weeklyPlan.dataCapBytes!;
  assert.equal(buildAuthorizeReply(kit(), weeklySub({ bytesUsed: cap - 1n }), weeklyPlan, START).result, 'accept');
  assert.deepEqual(buildAuthorizeReply(kit(), weeklySub({ bytesUsed: cap }), weeklyPlan, START), {
    result: 'reject',
    reason: 'data cap reached',
  });
  const uncapped: Plan = { ...weeklyPlan, dataCapBytes: undefined };
  assert.equal(buildAuthorizeReply(kit(), weeklySub({ bytesUsed: cap * 10n }), uncapped, START).result, 'accept');
});

test('rejects a NAS type outside the supported list', () => {
  const bad = { ...kit(), nasType: 'unifi' } as unknown as Kit;
  assert.deepEqual(buildAuthorizeReply(bad, weeklySub(), weeklyPlan, START), {
    result: 'reject',
    reason: 'unsupported NAS type: unifi',
  });
});
