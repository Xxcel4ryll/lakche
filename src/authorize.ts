import type { Kit, NasType, Plan, RadiusAttrs, Subscription } from './types.js';

export type AuthDecision =
  | { result: 'accept'; reply: RadiusAttrs }
  | { result: 'reject'; reason: string };

const reject = (reason: string): AuthDecision => ({ result: 'reject', reason });

export function buildAuthorizeReply(
  kit: Kit | undefined,
  sub: Subscription | undefined,
  plan: Plan | undefined,
  now: Date,
  interimSeconds = 300,
): AuthDecision {
  if (!kit) return reject('unknown kit');
  if (!sub) return reject('no subscription for this user');
  if (sub.revoked) return reject('subscription revoked');
  if (!plan || plan.id !== sub.planId) return reject('plan not found for subscription');

  const nowMs = now.getTime();
  if (nowMs < sub.startsAt.getTime()) return reject('subscription not started yet');

  // Derived from the absolute expiry, never from plan.durationSeconds, so a reconnect only gets the
  // time that is left. Rounded down so the session can never outlive the subscription. Less than one
  // second left counts as expired: Session-Timeout = 0 means "no limit" on some NAS.
  const remainingSeconds = Math.floor((sub.expiresAt.getTime() - nowMs) / 1000);
  if (remainingSeconds < 1) return reject('subscription expired');

  if (plan.dataCapBytes !== undefined && sub.bytesUsed >= plan.dataCapBytes) {
    return reject('data cap reached');
  }

  const bandwidth = bandwidthAttrs(kit.nasType, plan);
  if (!bandwidth) return reject(`unsupported NAS type: ${kit.nasType}`);

  return {
    result: 'accept',
    reply: {
      'Session-Timeout': remainingSeconds,
      'Acct-Interim-Interval': interimSeconds,
      ...bandwidth,
    },
  };
}

function bandwidthAttrs(nasType: NasType, plan: Plan): RadiusAttrs | undefined {
  switch (nasType) {
    case 'mikrotik':
      // rx/tx from the router's view: what the router receives is the client's upload.
      return { 'Mikrotik-Rate-Limit': `${plan.upKbps}k/${plan.downKbps}k` };
    case 'chilli':
    case 'omada':
      return {
        'WISPr-Bandwidth-Max-Up': plan.upKbps * 1000,
        'WISPr-Bandwidth-Max-Down': plan.downKbps * 1000,
      };
    default:
      // nasType comes from the database, so guard against values outside the union at runtime.
      return undefined;
  }
}

// Stretch: enforcing dataCapBytes on the kit itself
//
// - Send the remaining allowance (dataCapBytes - bytesUsed), not the whole cap: the NAS counts from 0
//   on every session, so a reconnecting user must only get what is left.
//     mikrotik: Mikrotik-Total-Limit + Mikrotik-Total-Limit-Gigawords
//     chilli:   ChilliSpot-Max-Total-Octets + ChilliSpot-Max-Total-Gigawords
//   The kit then ends the session itself when the quota is used up.
// - Omada has no volume-quota attribute, so enforce from the server: watch Interim-Updates (Task 2)
//   and send a Disconnect-Request (RFC 5176) once the cap is reached. Acct-Interim-Interval bounds
//   the overshoot.
// - Allow one session per subscription (Simultaneous-Use = 1 or a check here against open
//   sessions), or two devices would each get the full remaining allowance.
//
// Caps above 4 GB: RADIUS integers are 32-bit, so a single octets attribute wraps at 4 GiB. Split
// the value into octets = remaining & 0xFFFFFFFFn and gigawords = remaining >> 32n and send both.
// Keep the arithmetic in bigint until that split; accounting needs the same octets/gigawords
// handling (Task 2).
