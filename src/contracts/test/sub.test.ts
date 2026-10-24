import test from "node:test";
import assert from "node:assert/strict";
import { buildAuthorizeReply, type Kit, type Subscription, type Plan } from "../../types.ts/sub";


const now = new Date();


const kit: Kit = {
    id: "kx-kit-0001",
    nasType: "mikrotik",
    operatorId: "op-0001",
    countryCode: "CM",
}

const sub: Subscription = {
    id: "kx-sub-0001",
    userId: "user-0001",
    planId: "kx-plan-0001",
}

const plan: Plan = {
    id: "kx-plan-0001",
    durationSeconds: 3600,
    downKbps: 10000,
    upKbps: 10000,
    dataCapBytes: 1024 * 1024 * 1024,
    priceMinor: 1000000,
    currency: "XAF",
}

test("accepts an active subscription with remainin time", () => {
    const reply = buildAuthorizeReply(kit, sub, plan, now);

    assert.equal(reply.result, 'accept');

    if (result.result === 'accept') {
        assert.equal(reply.reply['session-timeout'], 3600);
        assert.equal(reply.reply['acct-interim-interval'], 300);
        assert.equal(reply.reply['mikrotik-nas-identifier'], kit.id);
    }
});

test("rejects an unknown kit", () => {
    const result = buildAuthorizeReply(undefined, sub, plan, now);

    assert.equal(result.result, 'reject');
})

test("rejects an unknown subscription", () => {
    const result = buildAuthorizeReply(kit, undefined, plan, now);

    assert.equal(result.result, 'reject');
})