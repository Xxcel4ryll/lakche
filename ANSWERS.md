# Answers

Code: Task 1 [src/authorize.ts](src/authorize.ts), Task 2 [src/accounting.ts](src/accounting.ts),
Task 3 [src/payments.ts](src/payments.ts), Task 4 [contracts/KXTDistributor.sol](contracts/KXTDistributor.sol).
The Task 1 stretch, the Task 2 persistence plan and the Task 3c rounding choice are explained in comments in those files.

## Task 4: Roles in production

- **DEFAULT_ADMIN_ROLE**: a Safe multisig on Celo (for example 3-of-5 hardware wallets held by founders and finance), behind a timelock. It only grants and revokes roles. Never an EOA, and it holds no other role.
- **ROOT_SETTER_ROLE**: one dedicated key used only by the epoch job. **PAUSER_ROLE**: the on-call engineers' hardware wallets plus an automated monitor. Pausing is cheap to hand out. Ideally unpausing would stay with the admin, which would need a separate unpause role in the contract.
- **Protecting the root-setter key**: keep it in a cloud KMS/HSM as a non-exportable secp256k1 key, usable only by the epoch job's IAM identity. Before signing, the job checks that no account's cumulative amount went down, and that the epoch's total increase stays within the emission cap and the contract balance. An independent verifier recomputes the tree from accounting data and must agree. Publish every tree, alert on each `MerkleRootUpdated` so pausers can react, and if the key leaks the admin revokes it and grants a new one.

## Task 5: Networking and ops

### 1. Disconnect a revoked user

Take the values from the user's open accounting session. Revoke in the database first, so the re-authentication that follows the disconnect is rejected.

```sh
echo 'User-Name = "user-1", Acct-Session-Id = "81a00007", Framed-IP-Address = 10.5.50.23' \
  | radclient -x -r 2 -t 3 10.8.0.14:3799 disconnect 'KIT_0007_SHARED_SECRET'
```

This sends a Disconnect-Request (Disconnect-Message) on **UDP 3799**, defined in **RFC 5176** (Dynamic Authorization Extensions to RADIUS, which replaced RFC 3576). The kit answers Disconnect-ACK or Disconnect-NAK. On the MikroTik this must be enabled with `/radius incoming set accept=yes port=3799`. The request must also come from the RADIUS server address configured in `/radius`, using that entry's secret.

### 2. Kits behind CGNAT

A kit behind CGNAT cannot accept inbound traffic, and its public IP is shared and changes. That breaks both identifying a kit by source IP and sending it CoA/Disconnect. So every kit dials out to us:

- The kit opens a VPN tunnel to a hub next to FreeRADIUS: WireGuard on RouterOS 7 and OpenWrt (CoovaChilli), OpenVPN where WireGuard is not available. `PersistentKeepalive = 25` keeps the NAT mapping open. Each kit gets a fixed tunnel IP (10.8.0.14 = kx-kit-0007), and both RADIUS and CoA travel inside the tunnel. RadSec (RFC 6614, TLS on TCP 2083, a client certificate per kit) is an alternative where supported, but CoA still needs a path back to the kit.
- **Identifying the kit**: FreeRADIUS matches the packet's source IP (the tunnel IP) to a `client` with its own per-kit secret, and a packet signed with the wrong secret fails authentication. The kit also sends `NAS-Identifier = kx-kit-0007`, which the API uses. FreeRADIUS checks that the identifier matches the client entry, so a kit cannot pose as another kit and take its rewards:

```
# clients.conf
client kx-kit-0007 {
    ipaddr    = 10.8.0.14
    secret    = per-kit-random-secret
    shortname = kx-kit-0007
}
```

```
# first lines of authorize {} and preacct {}
if (&NAS-Identifier != "%{client:shortname}") {
    reject
}
```

### 3. Walled garden for an in-portal mobile-money purchase with SMS OTP

- **Our portal and API hosts** (for example `portal.konectx.example`, `api.konectx.example`): the purchase page, order creation, OTP verification and payment-status polling all run there.
- **The payment provider's browser-facing domains**, but only if the customer uses the provider's hosted page or JS SDK (for example a checkout page where they type the provider's OTP). For a server-to-server USSD push, nothing is needed: the customer approves on the phone over the mobile network, and the provider's webhook goes to our server, not through the kit.
- **SMS OTP needs no entry**: the SMS arrives over the cellular network, and the code is submitted to our API. If OTP requests sit behind a captcha, add its exact hosts (`www.google.com` and `www.gstatic.com` for reCAPTCHA, or `hcaptcha.com` and `*.hcaptcha.com`).
- **Any CDN** the portal loads fonts or scripts from. Better to self-host those so the list stays short.
- **Leave out** the OS captive-portal probes (`captive.apple.com`, `connectivitycheck.gstatic.com`, `www.msftconnecttest.com`), otherwise phones think they are online and never open the login sheet. Use exact hostnames: a wildcard like `*.google.com` gives away free internet. On MikroTik, HTTPS hosts go in `/ip hotspot walled-garden ip`, because `/ip hotspot walled-garden` only covers HTTP through the hotspot proxy:

```
/ip hotspot walled-garden ip
add action=accept dst-host=portal.konectx.example comment="captive portal"
add action=accept dst-host=api.konectx.example comment="orders, OTP, payment status"
```

### 4. `sites-enabled/default`

Enable the module, then add `rest` to the two sections of the stock file. The rest of the stock file stays as it is.

```sh
ln -s ../mods-available/rest /etc/freeradius/3.0/mods-enabled/rest
```

```
authorize {
    preprocess
    rest        # POST /radius/authorize: 200 + attributes, 401 -> Access-Reject
    chap
    pap
}

accounting {
    rest        # POST /radius/accounting
}
```

In `mods-enabled/rest`, the `authorize` and `accounting` sections set `uri = "${..connect_uri}/radius/authorize"` (and `/radius/accounting`), `method = 'post'`, `body = 'json'`. The API returns the Task 1 reply attributes and `control:Cleartext-Password` (the voucher). The stock `pap` and `chap` modules then check the password, which also covers MikroTik's default CHAP login, where the API never sees the password in clear text.

### 5. API down for 10 minutes

- **Users already online stay online.** Session-Timeout and the rate limits are already enforced on the kit. Their Interim and Stop packets must not be lost, so accounting is decoupled from the API. FreeRADIUS writes each packet to a `detail` file and acknowledges the kit immediately. A `listen { type = detail }` virtual server (the stock `sites-available/buffered-sql`, with `sql` replaced by `rest`) replays the file into the API and only moves past an entry once the API accepts it. Replaying is safe because ingestion is idempotent (Task 2).
- **Returning subscribers can still reconnect.** On a successful Access-Accept, FreeRADIUS stores the reply in `rlm_cache`, keyed on User-Name. If the API call fails, it serves that cached reply instead, with a short Session-Timeout (for example 600 s). Each entry's TTL is 600 s shorter than the time left, so a cached accept can never run past the subscription's expiry. Revocations and data caps can lag by up to that TTL during an outage, which is an accepted trade-off.
- **New users and unknown users are rejected quickly, never let through (fail closed).** A new purchase cannot complete anyway, because payment needs the API. FreeRADIUS answers at once with an Access-Reject and a `Reply-Message`, so the portal can show "temporarily unavailable" instead of hanging.
- **Timeouts**: set the rest module's `timeout = 2` and give the kit more than that (`/radius set [find] timeout=3s` on MikroTik, where the default is 300 ms), so FreeRADIUS always answers before the kit gives up.

```
authorize {
    preprocess
    rest {
        fail = 1            # carry on to the fallback instead of returning
    }
    if (fail) {
        update control {
            &Cache-Read-Only := yes
        }
        cache_auth          # look up the last good reply only, never store from here
        if (!updated) {
            update reply {
                &Reply-Message := "Service temporarily unavailable, please try again shortly"
            }
            reject
        }
        update reply {
            &Session-Timeout := 600
        }
    }
    chap
    pap
}
```
