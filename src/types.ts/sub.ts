export type NasType = 'mikrotik' | 'chilli' | 'omada';

export interface Kit {
  id: string;
  nasType: NasType;
  operatorId: string;
  countryCode: string;
}
export interface Plan {
  id: string;
  durationSeconds: number;
  downKbps: number;
  upKbps: number;
  dataCapBytes?: bigint;
  priceMinor: bigint;
  currency: string;
}
// e.g. "kx-kit-0007", sent as NAS-Identifier
// ISO 3166-1 alpha-2, e.g. "CM"
// e.g. 10000 = 10 Mbps
// optional total cap
// integer minor units (XAF has 0 decimals)
// ISO 4217, e.g. "XAF", "USD"
export interface Subscription {
  id: string;
  userId: string;
  planId: string;
  startsAt: Date;
  expiresAt: Date;
  revoked: boolean;
  bytesUsed: bigint;
}

 export type RadiusAttrs = Record<string, string | number>;

 export type AuthDecision =
   | { result: 'accept'; reply: RadiusAttrs }
   | { result: 'reject'; reason: string };

   export function buildAuthorizeReply(
    kit: Kit | undefined,
    sub: Subscription | undefined,
    plan: Plan | undefined,
    now: Date,
    interimSeconds = 300,
  ): AuthDecision {
    if (!kit) {
     return { result: 'reject',  reason: 'Unknown kit'}
    }
 
    if (!sub) {
     return { result: 'reject', reason: 'Unknown subscription'}
    }
 
    if (sub.revoked) {
     return { result: 'reject', reason: 'Subscription revoked'}
    }
 
    if (!plan) {
     return { result: 'reject', reason: 'Unknown plan'}
    }
 
    const nowMs = now.getTime();
    const StartMs = sub.startsAt.getTime();
    const expiryMs = sub.expiresAt.getTime();
 
    if (!Number.isFinite(nowMs) || !Number.isFinite(StartMs) || !Number.isFinite(expiryMs)) {
     return { result: 'reject', reason: 'Invalid subscription dates'}
    }
 
    if (StartMs > nowMs) {
     return { result: 'reject', reason: 'Subscription has expired'}
    }
 
    if (nowMs >= expiryMs) {
     return { result: 'reject', reason: 'Subscription has expired'}
    }
 
    const sessionTimeout = Math.floor(expiryMs - nowMs) / 1000;
 
    if (sessionTimeout <= 0) {
     return { result: 'reject', reason: 'Subscription has expired'}
    }
 
    const reply: RadiusAttrs = {
     "session-timeout": sessionTimeout,
     "acct-interim-interval": interimSeconds,
    }
 
    switch (kit.nasType) {
     case 'mikrotik':
       reply["mikrotik-nas-identifier"] = kit.id;
       break;
     case 'chilli':
       reply["chilli-nas-identifier"] = kit.id;
       break;
     case 'omada':
       reply["omada-nas-identifier"] = kit.id;
       break;
    }
     
    return { result: 'accept', reply };
 }
 