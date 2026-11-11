---
title: Selling
description: Who sells, who charges and who licenses; the two ways to earn; opening a shop on your own Tebex store; the rules a seller answers for.
order: 5
---

This page is the long version of what the [home page](/), [Monetize](/developers) and
[Protect](/protect) say in pictures. It is for creators who sell a script and for server operators
who sell a perk.

> [!WARNING]
> Real checkout is **not live yet**. A shop can be set up and tested today, but checkout through
> Tebex stays off, for every shop, until Tebex approves it in writing. In development a mock
> provider plays the payment provider's part.

## Who does what

Every purchase names three parties, and every purchase screen shows them:

- **The seller sells.** Offers belong to the seller: free, monthly, annual or perpetual.
- **Tebex takes the payment**, on the seller's own Tebex store. SCRIPT//GO never takes a payment.
- **SCRIPT//GO issues the licence**, only after a payment event it verified, or by an audited
  administrative grant. Coming back from the checkout page grants nothing by itself.

What is sold is always the seller's own code. Never a game, its content, or access to it.

## A studio sells a script

A studio writes a script, for example a job system, and sells it to the people who run servers.

1. The operator buys the script on **the studio's Tebex store**.
2. **SCRIPT//GO** receives the verified payment event and issues a licence.
3. The licence carries **a key**, and each deployment is bound to one server.
4. **The server** runs the script, and checks its licence again on a schedule.

Each buyer gets a licence for their own servers. Updates and renewals follow the licence. A refund,
a lost dispute or an ended subscription closes it.

The release can be delivered encrypted. It then opens only on the servers bound to the licence, and
if a buyer is refunded their key stops being released. See
[Protect your work](/docs/protect-your-work).

What is sold: a licence to run the studio's script.

## An operator sells a perk

> [!NOTE]
> Built. Like every sale, it waits for real checkout: until then it runs against the mock provider
> only.

A server operator sells a perk to their players, for example a monthly VIP pass. The pass unlocks a
feature of the script the operator wrote for their own server.

1. **The player** buys the pass on **the operator's Tebex store**.
2. **SCRIPT//GO** receives the verified payment event and records the perk for that player.
3. **The SDK on the server** hears it from SCRIPT//GO within about 30 seconds. It asks; nothing is
   pushed to the server.
4. **The operator's script** unlocks the feature.

The perk renews with the subscription. A cancelled one lasts until the paid period ends; a refund
or a chargeback removes it at once.

The operator sets it up in [Dashboard → Perks](/dashboard/perks): the perks on sale, then the
servers linked to the account under **Servers**. Each link has a `sg_srv_` token, shown once, that
goes in the server's `scriptgo_server_token` setting. The script calls `ScriptGo.perks`. It is
wired on OPEN//77, Rust (Oxide and Carbon), the .NET kit's Lua guests and the standalone host; each
adapter's SETUP says what has run there. The protocol is in `docs/spec/perks.md`.

A buyer who is not signed in to SCRIPT//GO is tied to their player by **player match**
(`docs/spec/player-match.md`): the player types `/link <code>` in game, and a server whose operator
turns presence on (`scriptgo_presence`) lets the sign-in page recognise a connected player from a
keyed fingerprint of their address, never the address itself. Each adapter's SETUP says where it is
wired and what has run. The sign-in page side is not live yet.

What is sold: a feature of the operator's own code. Not the game, not its content, not access to
it.

## Open a shop

Anyone can open a SCRIPT//GO shop, on their own Tebex store. Free packages need no store at all.

1. Create the package in your own Tebex store. A monthly offer needs a recurring package.
2. Connect the store in [Dashboard → Stores](/dashboard/stores): paste the webhook secret (Tebex →
   Developers → Webhooks) and the public token (Tebex → Integrations → Headless API). Both are
   stored sealed and never shown again.
3. Copy the webhook address from the store card,
   `https://api.scriptgo.dev/v1/webhooks/tebex/<store id>`, and add it in Tebex → Developers →
   Webhooks → Endpoints. Select the payment and recurring payment events (listed below).
4. Map each paid offer and each perk to its Tebex package id.

You do this once per store. One address serves every script and every perk you sell there; there
is no address per product.

The shop works as soon as its Tebex configuration is complete. The one thing still off is real
checkout, platform-wide, until Tebex approves it in writing. The Tebex connector has not run
against a live store yet.

### What Tebex sends, and what SCRIPT//GO does with it

Tebex sends that address the events you selected, for **every** sale of the store.

- **Each request is checked.** Its signature must match your store's webhook secret; in
  production it must also come from one of Tebex's two published sender addresses. A request that
  fails is refused.
- **Only SCRIPT//GO's own sales count.** A buyer who starts from SCRIPT//GO gets a Tebex basket
  that carries a SCRIPT//GO checkout reference, and the event brings it back. SCRIPT//GO then checks
  the amount, the currency and the package before it issues a licence or grants a perk.
- **Other sales are left alone.** A sale made on the same store outside SCRIPT//GO carries no
  reference, so SCRIPT//GO does nothing with it.

Events used: `payment.completed`, `payment.declined`, `payment.refunded`,
`payment.dispute.opened`, `payment.dispute.won`, `payment.dispute.lost`,
`payment.dispute.closed`, `recurring-payment.started`, `recurring-payment.renewed`,
`recurring-payment.ended`, `recurring-payment.cancellation.requested`,
`recurring-payment.cancellation.aborted`, and `validation.webhook`, which Tebex sends when the
address is added. Other events are ignored.

Game servers never hear from Tebex. They learn about purchases from SCRIPT//GO, through the SDK:
see [Player perks](/docs/perks#how-it-works-in-short).

## The rules

- **A script is sold as a SCRIPT//GO script.** Package and offer pages say "runs on", followed by
  the environments. It is never sold "for" a platform.
- **Sellers declare their rights, and answer for what they sell.** You declare on every release
  that you wrote the code or may distribute it, list third-party assets with their licences, and
  say whether the package targets a proprietary game. Publishing, protecting or selling through
  SCRIPT//GO transfers none of your rights to us.
- **An offer with a declaration is on sale.** SCRIPT//GO does not pre-approve offers or stores.
- **SCRIPT//GO acts on reports.** Anyone can [report a package](/report), with or without an
  account. A reported listing can be restricted, suspended or taken down, with a notice to its
  creator and a right of appeal. The process is in the [IP policy](/legal#ip-policy).
- **No environment allows or forbids a sale on SCRIPT//GO.** A platform may have its own rule
  about paid mods, set by its rights holder. That rule is noted on the platform's
  [environment page](/environments), and whoever runs a script there answers for following it.
- **A game's intellectual property is never ours to sell, and never a seller's.** A package holds
  what its creator wrote and made. See [The game's IP](/docs/protect-your-work#the-games-ip).

## From folder to store

The steps a creator follows. Each one is a page of its own:

| Step | What happens | Command |
|---|---|---|
| Create a resource | A folder with a manifest and your shared, server and client scripts: the resource shape multiplayer scripters already know. Lua runs in every environment; TypeScript on the .NET kit | `scriptgo init inventory_pro` |
| Test it locally | Runs your `test_script` files in the standalone host, the reference environment | `scriptgo test` |
| Publish a release | Uploads the archive. Validation checks archive safety, the manifest and hashes; compatibility runs decide each environment's status | `scriptgo publish` |
| Protect a paid release (optional) | Publish it encrypted. The key is released only to a licensed server bound by its own key, and you choose which files stay readable. The site offers the same option on the new-release page | `scriptgo publish --escrow` |
| Open your shop (optional) | Connect your own Tebex store and map its products to your offers, as above | |

The manifest is parsed, never executed. Unknown directives are kept as warnings, so one file can
serve several environments:

```lua
resource "inventory_pro"
version "1.4.1"
scriptgo_version ">=0.1.0"

title "Inventory Pro"
license "MIT"
category "inventory"

lua { "5.1", "5.4", "luajit" }
environments { "standalone", "love2d", "godot", "luanti" }
capabilities { "events", "storage" }
optional_capabilities { "ui" }

shared_script "shared/core.lua"
server_script "server/main.lua"
test_script "tests/core_test.lua"
```

The `scriptgo` CLI is in preview. Install it from the SDK's GitHub release (see
[CLI](/docs/cli#install)) and sign it in with a personal access token from
[Dashboard → Settings](/dashboard/settings). See [Quickstart](/docs/quickstart),
[Manifest](/docs/manifest) and [CLI](/docs/cli).

## Licences

Licences guard paid resources: one key per buyer, one activation per server, signed answers with an
offline grace period. A resource checks its licence with the
[licensing API](/docs/licensing-api).

Every release is signed, and a release can also be encrypted. The key of an encrypted release goes
only to a licensed server bound by its own key, and each delivery is marked. On a host that runs
compiled code it is decrypted in memory; on a host that runs plain script the protection is the
licence and the signature. Only server scripts are protected. It deters copying and makes leaks
traceable. It does not make copying impossible.

## For platform builders

There are two ways to bring SCRIPT//GO to an engine or a mod platform, and either way its creators
can protect and monetize what they build there.

- A host that runs Lua writes one adapter: a clock and a tick, persistence, players, privileges,
  notification output and, optionally, HTTP. The portable core knows nothing about engines. See
  [Create an adapter](/docs/create-adapter).
- An engine or server written in .NET embeds the .NET host kit instead, which runs Lua and
  TypeScript side by side. It is experimental. See [Embed the .NET kit](/docs/dotnet-kit).

See also [The SDK](/docs/sdk), the [Runtime API](/docs/runtime) and the
[environments and their status](/docs/environments).

## Protection without a sale

A creator can give a free licence for one of their own packages, to an account or to a server key:
[Dashboard → Packages](/dashboard/packages), **Grant a free license**, or `scriptgo grant`. Nothing
is sold and no store is needed. The release is still bound to that server and delivered the same
way. See [Protect without selling](/docs/protect-your-work#protect-without-selling).

## In development

Announced and being built. Not usable yet.

| Item | What it is |
|---|---|
| Minify at packaging | An optional step that makes packaged script harder to read. It is a speed bump, never protection, and it is never counted as such |
