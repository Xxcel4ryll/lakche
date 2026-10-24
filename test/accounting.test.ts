import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type AcctPacket, UsageLedger, toBytes } from '../src/accounting.js';

const GiB4 = 2n ** 32n;

const packet = (overrides: Partial<AcctPacket>): AcctPacket => ({
  statusType: 'Interim-Update',
  sessionId: 'sess-1',
  nasIdentifier: 'kx-kit-0007',
  userName: 'user-1',
  inputOctets: 0,
  inputGigawords: 0,
  outputOctets: 0,
  outputGigawords: 0,
  eventTimestamp: 1_772_438_400,
  ...overrides,
});

test('counts only the increase between packets of a session', () => {
  const ledger = new UsageLedger();
  assert.equal(ledger.ingest(packet({ statusType: 'Start' })), 0n);
  assert.equal(ledger.ingest(packet({ inputOctets: 1_000, outputOctets: 9_000, eventTimestamp: 1_772_438_700 })), 10_000n);
  assert.equal(ledger.ingest(packet({ statusType: 'Stop', inputOctets: 1_500, outputOctets: 12_000, eventTimestamp: 1_772_438_800 })), 3_500n);
  assert.equal(ledger.bytesServedByKit('kx-kit-0007'), 13_500n);
  assert.equal(ledger.bytesUsedByUser('user-1'), 13_500n);
});

test('a duplicate Interim adds nothing', () => {
  const ledger = new UsageLedger();
  const interim = packet({ inputOctets: 4_000, outputOctets: 6_000 });
  assert.equal(ledger.ingest(interim), 10_000n);
  assert.equal(ledger.ingest({ ...interim }), 0n);
  assert.equal(ledger.bytesServedByKit('kx-kit-0007'), 10_000n);
});

test('an Interim arriving after the Stop adds nothing', () => {
  const ledger = new UsageLedger();
  ledger.ingest(packet({ statusType: 'Start' }));
  assert.equal(ledger.ingest(packet({ statusType: 'Stop', inputOctets: 2_000, outputOctets: 8_000, eventTimestamp: 1_772_439_000 })), 10_000n);
  assert.equal(ledger.ingest(packet({ inputOctets: 1_000, outputOctets: 5_000, eventTimestamp: 1_772_438_700 })), 0n);
  assert.equal(ledger.bytesServedByKit('kx-kit-0007'), 10_000n);
});

test('a Stop or Interim without a Start is still counted', () => {
  const ledger = new UsageLedger();
  assert.equal(ledger.ingest(packet({ statusType: 'Stop', inputOctets: 700, outputOctets: 300 })), 1_000n);
  assert.equal(ledger.ingest(packet({ sessionId: 'sess-2', inputOctets: 50, outputOctets: 50 })), 100n);
  assert.equal(ledger.bytesUsedByUser('user-1'), 1_100n);
});

test('a session crossing 4 GB counts octets plus gigawords', () => {
  const ledger = new UsageLedger();
  assert.equal(ledger.ingest(packet({ outputOctets: 4_294_000_000 })), 4_294_000_000n);
  // The 32-bit octet counter wrapped and the gigaword counter went to 1.
  assert.equal(ledger.ingest(packet({ outputOctets: 1_000_000, outputGigawords: 1 })), GiB4 + 1_000_000n - 4_294_000_000n);
  assert.equal(
    ledger.ingest(packet({ statusType: 'Stop', inputOctets: 5, inputGigawords: 1, outputOctets: 1_000_000, outputGigawords: 2 })),
    GiB4 + 5n + GiB4,
  );
  assert.equal(ledger.bytesServedByKit('kx-kit-0007'), GiB4 + 5n + 2n * GiB4 + 1_000_000n);
});

test('out-of-order Interims never double count', () => {
  const ledger = new UsageLedger();
  assert.equal(ledger.ingest(packet({ inputOctets: 300, outputOctets: 300, eventTimestamp: 1_772_439_000 })), 600n);
  assert.equal(ledger.ingest(packet({ inputOctets: 100, outputOctets: 100, eventTimestamp: 1_772_438_700 })), 0n);
  assert.equal(ledger.ingest(packet({ inputOctets: 400, outputOctets: 300, eventTimestamp: 1_772_439_300 })), 100n);
  assert.equal(ledger.bytesServedByKit('kx-kit-0007'), 700n);
});

test('sessions are kept apart per kit, and totals are per kit and per user', () => {
  const ledger = new UsageLedger();
  ledger.ingest(packet({ outputOctets: 1_000 }));
  ledger.ingest(packet({ nasIdentifier: 'kx-kit-0008', outputOctets: 1_000 })); // same session id, other kit
  ledger.ingest(packet({ sessionId: 'sess-9', userName: 'user-2', outputOctets: 500 }));
  assert.equal(ledger.bytesServedByKit('kx-kit-0007'), 1_500n);
  assert.equal(ledger.bytesServedByKit('kx-kit-0008'), 1_000n);
  assert.equal(ledger.bytesUsedByUser('user-1'), 2_000n);
  assert.equal(ledger.bytesUsedByUser('user-2'), 500n);
  assert.equal(ledger.bytesServedByKit('unknown'), 0n);
});

test('toBytes rejects counters that are not 32-bit unsigned integers', () => {
  assert.equal(toBytes(2 ** 32 - 1, 3), 3n * GiB4 + GiB4 - 1n);
  assert.throws(() => toBytes(2 ** 32, 0), RangeError);
  assert.throws(() => toBytes(-1, 0), RangeError);
  assert.throws(() => toBytes(1.5, 0), RangeError);
  assert.throws(() => toBytes(0, -1), RangeError);
});
