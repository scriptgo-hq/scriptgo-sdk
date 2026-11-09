---
title: Licensing API
description: Activate a license on a deployment, verify it from your server, and keep running through short outages.
order: 6
---

Paid resources check their license at runtime. This page is for the people running those
deployments (customers) and for creators who add a license check to their resource.

## Who does what

Every purchase on SCRIPT//GO involves three parties, and every purchase screen names them:

- **The creator sells.** The creator sets the offers and is the seller.
- **The provider takes the payment.** For example Tebex. In development, a mock provider plays
  this role.
- **SCRIPT//GO issues the license.** The license, its key and its deployments live here.

A license is only granted by a **signed provider webhook** that SCRIPT//GO verified, or by an
**audited administrative grant**. Returning from the checkout page grants nothing on its own.
Checkout stays disabled until the provider approves the store.

## The flow

1. **Get a key.** After payment, the license appears in [Dashboard → Licenses](/dashboard/licenses)
   with a key such as `sg_live_…a91c`. You can copy and rotate it there.
2. **Activate** each deployment once. Activation binds the license to a named instance
   (`prod-eu-1`) in one environment and returns a `deploymentToken`.
3. **Verify** regularly from the server. The answer includes a short-lived token signed with
   ed25519.
4. **Offline grace.** If SCRIPT//GO is unreachable, the deployment may keep running until the
   `offlineGraceUntil` of its last valid answer. The period is set by the platform
   (`LICENSE_OFFLINE_GRACE_HOURS`, 72 hours by default). `ScriptGo.licensing` does not track it
   for you: the resource keeps its last valid answer, for example in `ScriptGo.storage`.

You can also add a deployment from the license page in the dashboard. It calls
`POST /v1/me/licenses/:id/deployments` and also returns a `deploymentToken`.

> [!WARNING]
> Keep the license key on your server. Never ship it inside client-side scripts, a game build or
> a public repository. Anyone holding the key can use your deployment slots.

## Endpoints

All bodies are JSON. Errors use the standard body
`{ "error": { "code": "snake_case", "message": "Human sentence." } }`.

### POST /v1/licenses/activate

```json
{
  "licenseKey": "sg_live_…",
  "package": "kestrel//inventory-pro",
  "environment": "luanti",
  "deploymentName": "prod-eu-1",
  "adapterVersion": "0.3.0"
}
```

Response, HTTP 201:

```json
{ "activationId": "…", "deploymentToken": "…" }
```

`package` is the `creator//name` identifier or the manifest resource name (`inventory_pro`).
Activating the same deployment name again in the same environment rotates its token.

Activation fails with:

| HTTP | Code | Meaning |
|---|---|---|
| 404 | `unknown_key` | The key does not exist, or belongs to another package |
| 409 | `deployment_limit` | Every deployment slot is in use. Deactivate an old deployment first |
| 409 | `deployment_exists` | A deployment with this name exists in another environment |
| 409 | the license status, e.g. `expired` | The license cannot be used |
| 422 | `environment_not_covered` | The license does not cover this environment |

### POST /v1/licenses/verify

Send exactly one of the license key or the deployment token:

```json
{
  "deploymentToken": "…",
  "package": "kestrel//inventory-pro",
  "environment": "luanti",
  "adapterVersion": "0.3.0"
}
```

Response:

```json
{
  "valid": true,
  "reason": null,
  "status": "active",
  "activationStatus": "active",
  "expiresAt": "…",
  "offlineGraceUntil": "…",
  "environments": ["standalone", "love2d", "godot", "luanti"],
  "token": "…"
}
```

`token` is ed25519-signed and short-lived. Store it on the deployment; it is what proves the
license during an outage.

When the license cannot be used, the answer is still HTTP 200: `valid` is `false` and a `reason`
says why. Any 4xx or 5xx answer, 429 included, means the API could not answer; keep relying on
the last valid answer. Only a body with neither or both of `licenseKey` and `deploymentToken`
gets a 400.

| Reason | Meaning | What to do |
|---|---|---|
| `expired` | The paid period ended | Renew at the provider, then verify again |
| `revoked` | The license was revoked | Read the reason on the license page; contact support |
| `refunded` | The payment was refunded | Buy a new license |
| `deactivated` | The deployment token belongs to a deactivated deployment | Activate the deployment again |
| `environment_not_covered` | The plan does not cover this environment | Use a covered environment or change plan |
| `deployment_limit` | More deployments are active than the license allows | Deactivate an unused deployment |
| `unknown_key` | The key or token does not exist, is malformed, or belongs to another package | Check for a typo, or a key rotated since |

`verify` never reveals another customer's data, and answers the same way to every unknown key.

### POST /v1/licenses/deactivate

```json
{ "licenseKey": "sg_live_…", "activationId": "…" }
```

Response: `{ "ok": true }`. The slot is free again.

### GET /v1/licenses/public-key

```json
{ "alg": "ed25519", "publicKey": "…", "kid": "…" }
```

Use this key to check the signature of verify tokens offline.

### GET /v1/licenses/:id

Returns the full license (deployments, history). Owner only, with a signed-in session or a
personal access token, so it is meant for the dashboard, not for deployments.

## Rate limits

`verify` is rate-limited per key (60 per minute) and per IP (300 per minute); `activate` and
`deactivate` allow 30 per minute per IP. Verify on start and then at a modest interval, not on
every tick or every player action. When a call is refused, keep using the last signed token and
retry later.

## curl

```bash
curl -sS -X POST "$SCRIPTGO_API/v1/licenses/activate" \
  -H "Content-Type: application/json" \
  -d '{"licenseKey":"'"$SCRIPTGO_LICENSE_KEY"'","package":"kestrel//inventory-pro","environment":"luanti","deploymentName":"prod-eu-1","adapterVersion":"0.3.0"}'

curl -sS -X POST "$SCRIPTGO_API/v1/licenses/verify" \
  -H "Content-Type: application/json" \
  -d '{"deploymentToken":"'"$SCRIPTGO_DEPLOYMENT_TOKEN"'","package":"kestrel//inventory-pro","environment":"luanti","adapterVersion":"0.3.0"}'
```

Read the key and token from environment variables or a secrets store, as above, never from a
file inside the resource.

## From Lua

Creators add a license check to their resource with the `licensing` capability.

```lua
-- scriptgo.lua
licensed true
capabilities { "events", "storage", "licensing" }
```

```lua
-- server/license.lua
CreateThread(function()
  local result, code = ScriptGo.licensing.verify({
    licenseKey = GetConvar("inventory_pro_license_key", ""),
    package = "kestrel//inventory-pro",
  })
  if not result then
    -- Transport or host error: nil, code, body (see Runtime).
    ScriptGo.log.error("Inventory Pro license check could not run: " .. tostring(code))
    return
  end
  if not result.valid then
    ScriptGo.log.error("Inventory Pro license check failed: " .. tostring(result.reason))
    return
  end
  ScriptGo.log.info("Inventory Pro licensed until " .. tostring(result.expiresAt))
end)
```

`licensing.verify(opts)` is server side only, runs inside a thread, and calls
`POST /v1/licenses/verify`. `opts` takes `licenseKey` or `deploymentToken`, and `package`; the
host adds `environment` and `adapterVersion` itself. `licensing.activate(opts)` takes
`licenseKey`, `package` and `deploymentName` and calls `POST /v1/licenses/activate`. Both send to
the API named by the `scriptgo_api` convar (default `http://localhost:4100`) and return the
decoded answer, or `nil, code, body` when the call failed or the API answered 4xx/5xx.

> [!CAPABILITY] licensing
> A resource that declares `licensing` as required does not start where the host cannot provide
> it. Licensing goes through the host's outbound HTTP: Godot has none, Luanti needs the mod in
> `secure.http_mods`, and OPEN//77 needs the operator to set `http.enabled` and list the API host
> in `http.allowedHosts` in `server.jsonc`.

## License states

| Status | Meaning |
|---|---|
| `active` | Paid and current |
| `grace` | A payment failed; still active until a date |
| `cancelled_active` | Cancelled at the provider; active until the end of the paid period |
| `expired` | The period ended; deployments are blocked |
| `revoked` | Revoked by SCRIPT//GO, with a reason |
| `refunded` | Refunded through the provider |

Deployments report `pending` (waiting for the first check), `active`, `offline_grace`,
`deactivated` or `blocked`.
