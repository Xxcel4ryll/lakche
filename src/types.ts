export type NasType = 'mikrotik' | 'chilli' | 'omada';

export interface Kit {
  id: string;              // e.g. "kx-kit-0007", sent as NAS-Identifier
  nasType: NasType;
  operatorId: string;
  countryCode: string;     // ISO 3166-1 alpha-2, e.g. "CM"
}

export interface Plan {
  id: string;
  durationSeconds: number;
  downKbps: number;        // e.g. 10000 = 10 Mbps
  upKbps: number;
  dataCapBytes?: bigint;   // optional total cap
  priceMinor: bigint;      // integer minor units (XAF has 0 decimals)
  currency: string;        // ISO 4217, e.g. "XAF", "USD"
}

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
