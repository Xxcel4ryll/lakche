export interface AcctPacket {
  statusType: 'Start' | 'Interim-Update' | 'Stop';
  sessionId: string;        // Acct-Session-Id
  nasIdentifier: string;    // kit id
  userName: string;
  inputOctets: number;      // Acct-Input-Octets, cumulative for the session, 32-bit
  inputGigawords: number;   // Acct-Input-Gigawords
  outputOctets: number;
  outputGigawords: number;
  eventTimestamp: number;   // seconds since epoch
}

const MAX_OCTETS = 2 ** 32;

/** Highest cumulative counters accepted so far for one session. */
interface SessionMarks {
  inputBytes: bigint;
  outputBytes: bigint;
}

/**
 * Counters are cumulative and only grow within a session, so the bytes a session has served are its
 * highest counters ever seen. Counting only the rise above those high-water marks makes ingestion
 * idempotent: a retransmit or an older packet (an Interim arriving after the Stop, say) carries
 * counters at or below the marks and adds nothing. A Stop or Interim without a Start starts from 0,
 * which is the true baseline of every session, so nothing is lost when the Start goes missing.
 *
 * Persistence (MongoDB):
 * - acct_sessions: one document per session holding the marks.
 *     { nasIdentifier, acctSessionId, userName, inputBytes: Long, outputBytes: Long, lastEventAt, stoppedAt }
 *   Unique index: { nasIdentifier: 1, acctSessionId: 1, userName: 1 }. Acct-Session-Id is only unique per
 *   NAS, and some kits reuse ids after a reboot, so in production I would key on FreeRADIUS's
 *   Acct-Unique-Session-Id (acct_unique hashes NAS, session id, user and session start).
 *   Ingest is one atomic findOneAndUpdate(key, { $max: { inputBytes, outputBytes } },
 *   { upsert: true, returnDocument: 'before' }); the "before" document gives the delta, so concurrent
 *   retransmits cannot both count it (retry once on E11000 from a racing upsert).
 * - usage_deltas: { sessionKey, kitId, userName, bytes, at } inserted in the same transaction when the
 *   delta is positive. Reward epochs and user totals are sums over these, never hand-maintained counters.
 * - Raw packets in an append-only collection with a TTL index, for audit and replay.
 */
export class UsageLedger {
  private readonly sessions = new Map<string, SessionMarks>();
  private readonly servedByKit = new Map<string, bigint>();
  private readonly usedByUser = new Map<string, bigint>();

  /** Returns the NEW bytes counted from this packet (0n if nothing new). */
  ingest(p: AcctPacket): bigint {
    const input = toBytes(p.inputOctets, p.inputGigawords);
    const output = toBytes(p.outputOctets, p.outputGigawords);

    const key = JSON.stringify([p.nasIdentifier, p.sessionId, p.userName]);
    const marks = this.sessions.get(key) ?? { inputBytes: 0n, outputBytes: 0n };

    const newInput = input > marks.inputBytes ? input - marks.inputBytes : 0n;
    const newOutput = output > marks.outputBytes ? output - marks.outputBytes : 0n;
    marks.inputBytes += newInput;
    marks.outputBytes += newOutput;
    this.sessions.set(key, marks);

    const added = newInput + newOutput;
    if (added > 0n) {
      addTo(this.servedByKit, p.nasIdentifier, added);
      addTo(this.usedByUser, p.userName, added);
    }
    return added;
  }

  bytesServedByKit(kitId: string): bigint {
    return this.servedByKit.get(kitId) ?? 0n;
  }

  bytesUsedByUser(userName: string): bigint {
    return this.usedByUser.get(userName) ?? 0n;
  }
}

/** Combines a 32-bit octet counter and its gigaword counter (units of 2^32 bytes). */
export function toBytes(octets: number, gigawords: number): bigint {
  if (!Number.isInteger(octets) || octets < 0 || octets >= MAX_OCTETS) {
    throw new RangeError(`octets must be a 32-bit unsigned integer, got ${octets}`);
  }
  if (!Number.isInteger(gigawords) || gigawords < 0) {
    throw new RangeError(`gigawords must be a non-negative integer, got ${gigawords}`);
  }
  return (BigInt(gigawords) << 32n) + BigInt(octets);
}

function addTo(totals: Map<string, bigint>, key: string, bytes: bigint): void {
  totals.set(key, (totals.get(key) ?? 0n) + bytes);
}
