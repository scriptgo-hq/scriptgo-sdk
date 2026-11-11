# Finding a buyer's game identity

**Status: the game server side is built in the SDK (presence and `/link`, see "What each adapter
adds"); the API and the sign-in page are built against this page (scriptgo-api, ADR-0042), not yet
in production.** This page is the contract.

A buyer on a seller's shop (their Tebex webstore, or a shop page on scriptgo.dev) has to be tied to a
player of a game server, so that a perk they pay for reaches the right player. They must not need a
SCRIPT//GO account, a link, or anything typed when it can be avoided. The platform does not matter:
it works wherever the SCRIPT//GO SDK runs, through the SDK alone.

## In plain words

1. While a player is connected, the SDK tells SCRIPT//GO "this player is here, from this address",
   as a keyed fingerprint of the address. Only on a host with no HMAC, and only if the operator turns
   address mode on, is the address itself sent, and SCRIPT//GO fingerprints it at once. It is
   forgotten when they leave.
2. The buyer signs in on the shop with "Sign in with SCRIPT//GO". Our page compares the fingerprint
   of the browser's address with the players connected right now.
3. **Found, exactly one:** the page shows "You are **PlayerName** on **Harbor City RP**?". One click
   on "Yes, that's me" and the shop knows the player.
4. **Not found, or more than one:** the page shows a short code and says "Type `/link MT4-2JF` in
   game". The game server confirms it.
5. The browser is remembered, so it is done once.

The player's name comes from the SDK (what the game server reports), so the buyer sees the name the
game knows. A wrong match is visible before anything is bought.

## Why the address is a hint and the click is the proof

An address does not identify a person. Several players share one (a family, a dorm, a café, a mobile
carrier's shared address); one player has several (phone on mobile data, PC on Wi-Fi, a VPN; IPv6 in
the browser, IPv4 in the game). So:

- A match is offered only when **exactly one** connected player has the browser's fingerprint.
  Several candidates, none, or any doubt: the code.
- The buyer always sees the player's name and server and confirms. Nothing is attached silently.
- The player must be connected at that moment. A buyer browsing while not in game gets the code.

## Identity

A game identity is `<environment>:<identifier>`, where `identifier` is what the host's
`ScriptGo.players.identifier(player)` returns (`perks.md`, "The player identifier"): for example
`open77:<account id>` or `rust:steam:76561198000000001`. It is as trustworthy as the platform's own
authentication of players. An environment whose identifiers a player can choose cannot be matched.

The identity is the same on every server of that environment, so a match made on any server running
the SDK holds for every seller on that environment.

## Presence: what the SDK sends

Opt-in, per server, by the operator (`scriptgo_presence`, default off). It needs the host to read a
connected player's address, which on some platforms is a permission the operator grants (OPEN//77:
`players.identity.sensitive`, read through `Open77.players.endpoint`). Without it, only the code works.

Every request carries the server link token (`perks.md`, "The protocol a game server speaks"), and
every body (presence reports, the empty one included, and code confirms) names the environment and
the adapter version, as `POST /v1/perks/check` does: the identity is `<environment>:<identifier>`,
and a server link only knows its environment from what the server said.

```
POST /v1/presence
{ "players": [ { "player": "<identifier>", "name": "PlayerName", "fp": ["<fingerprint>", ...] } ],
  "environment": "rust", "adapterVersion": "rust-0.1.0" }
```

- Sent when a player joins, then with the perks poll (every 30 s) for everyone still connected, and
  `DELETE /v1/presence/<identifier>` when they leave. An entry not refreshed for 2 minutes is gone.
- The fingerprint is `HMAC-SHA256(presenceKey, normalised address)`, hex. `presenceKey` is given by the
  API in each answer (`{ "presenceKey": "...", "rotatesAt": "..." }`), rotates daily, and is the same
  for every server link of an environment, so fingerprints from two servers compare. The raw address
  never leaves the game server, except in address mode (below).
- Normalisation: IPv4 as dotted quad; IPv6 as its `/64` prefix (privacy addresses change inside it);
  an IPv4-mapped IPv6 address as IPv4. The port is dropped.
- SCRIPT//GO keeps only `{ environment, identifier, name, server link, fingerprints, lastSeen }`, in
  memory or a short-lived table, never in logs.

### The presence protocol in detail

The schemas are `packages/shared/src/presence.ts`; the SDK's side is `sdk/lua/scriptgo/presence.lua`.

- **The key.** `presenceKey` is 16 to 128 characters of `A-Z a-z 0-9 _ -`, used as the UTF-8 bytes
  of the string. A server that has no key yet sends `{ "players": [] }`: an empty list is valid and
  is how it learns the key (the answer is the same `{ "accepted", "presenceKey", "rotatesAt" }`).
  When an answer brings a key other than the one the report was hashed with, the server reports
  again at once with the new key, once. It also reports again at `rotatesAt`.
- **The message** hashed is the normalised address as text, the fingerprint is lowercase hex:

  | Address seen by the game server | Normalised |
  |---|---|
  | `203.0.113.9:30120` | `203.0.113.9` |
  | `[2001:db8:0:1:aaaa:bbbb:cccc:dddd]:28015`, `2001:0db8:0000:0001::1%eth0` | `2001:db8:0:1::/64` |
  | `::ffff:198.51.100.23` | `198.51.100.23` |

  IPv4: four decimal octets, no leading zeros. IPv6: the first four groups in lowercase hex without
  leading zeros, then `::/64`. Brackets, zone and port are dropped. Anything else is not reported.
  Vectors (Node `crypto.createHmac`): key `pk_test_20261111`, `203.0.113.9` →
  `048bfae99c6a7a6e511353e1c419cb4f8d32f8ac0700067cf6b1b4170bcac946`; the other vectors are in
  `sdk/lua/spec/presence_spec.lua`.
- **An entry** is `{ player, name, fp }` or `{ player, name, addr }`, exactly one of `fp` and
  `addr`: `name` is 1 to 64 bytes (cut at a UTF-8 character boundary; the identifier when the game
  gives no name), `fp` holds 1 to 4 fingerprints (the SDK sends one), at most 1000 entries per
  request.
- **Environment.** `environment` (`^[a-z0-9][a-z0-9_-]{0,63}$`) and `adapterVersion` (at most 128
  characters) on every body. The API takes the body's `environment`, else the one the link last
  reported (a perks check). The SDK always sends both, so a server that never ran a perks check is
  not refused.
- **Address mode** (`addr`), for a host with no vetted HMAC: the entry carries the normalised address
  (1 to 4, the SDK sends one) instead of fingerprints, and the API fingerprints it at once with the
  day's key and drops it: never stored, logged or echoed, even in an error. It is a second opt-in,
  `scriptgo_presence_addr` (default off; the owner's decision on it is pending), on top of
  `scriptgo_presence`. The SDK logs once that it is on, never the address. A host that has an HMAC
  sends fingerprints even with the setting on. The API accepts both modes.
- **Removal.** `DELETE /v1/presence/<identifier>` with the identifier percent-encoded; it answers
  `200 { "removed": true | false }`. The SDK removes every player it reported, including one who
  leaves before the answer.
- **Failures.** 401 or 403: the server is not linked, and stops reporting until it is. 409
  `environment_unknown`: the API does not know the link's environment (the body named none and no
  perks check did). 409 `environment_not_matchable`: the environment is not matched on that
  deployment (in production only `open77` and `rust` are; standalone and dotnet identifiers are
  chosen by the player). 400 `validation_failed`: a malformed body, or an `addr` that does not
  normalise, which refuses the whole request without echoing it. For any failure, 429 included, the
  next report waits the poll period × 2ⁿ, at most 300 seconds.

## The sign-in page

Part of the OpenID interaction (ADR on the OpenID provider): a second way to finish it, besides
signing in with a SCRIPT//GO account.

1. The page computes the browser's fingerprints with the current key: the address it sees, plus the
   IPv4 address read from an IPv4-only host (`v4.api.scriptgo.dev`, A record only) when the first was
   IPv6. This needs the real client address: requests reaching the API through the website must carry
   it (the open item "the API sees Vercel's addresses" must be fixed first).
2. Exactly one live presence entry matches: show its name and server, "Yes, that's me" or "Not me".
3. Otherwise, or on "Not me": a code.

### The code

```
(the sign-in page)  POST /oidc/interaction/<uid>/player   step "code": shows a code
                    GET  /oidc/interaction/<uid>/code     the code's state, polled by the page
(a game server)     POST /v1/identity/codes/confirm       server link token
{ "code": "MT4-2JF", "player": "<identifier>", "name": "PlayerName",
  "environment": "rust", "adapterVersion": "rust-0.1.0" }
```

- The sign-in page creates the code inside the OpenID interaction, under `/oidc/interaction/<uid>/...`,
  bound to the browser by the provider's interaction cookie; there is no `POST /v1/identity/codes`
  route (an earlier draft of this page had one). Only the confirm is a game server route.
- Six characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no `I`, `L`, `O`, `0` or `1`), shown
  `XXX-XXX` (for example `MT4-2JF`), one use, 10 minutes, bound to the interaction. Rate limited per
  sign-in, per address and per server link.
- The SDK registers the command (`scriptgo_link_command`, default `link`) and calls `confirm` for the
  player who typed it. The player sees "Linked: you can go back to your browser." The page, polling
  the code's state, continues on its own.
- The identity confirmed is the player the game server authenticated; the code only carries it.
- **Confirm in detail.** Body `{ "code", "player", "name"?, "environment"?, "adapterVersion"? }`
  (the SDK always sends the last two): `code` is every word the player typed after the command,
  joined, with spaces removed and upper-cased (`/link mt4 2jf` sends `MT42JF`; 4 to 16 of
  `A-Z 0-9 -`), and the API compares codes ignoring case, spaces and dashes; `name` is optional, so
  the page can say "Continue as **name**". It answers `200 { "linked": true }`. Refusals
  (`{ "error": { "code" } }`): 404 `unknown_code`, 410 `code_expired` or `code_used`, 429
  `rate_limited`, 401 `unknown_server_link`, 409 `environment_unknown` or
  `environment_not_matchable`, 400 `validation_failed`. The player reads, in plain words: "Linked: you can go back to your browser.";
  for any refused code "That code is not valid: it may be mistyped, already used, or older than 10
  minutes. Ask the page for a new one."; "Too many tries. Wait a minute, then try again."; and, when
  the server is not linked or SCRIPT//GO cannot be reached, a sentence saying so.

### Remembering the browser

After a match or a code, the browser holds a signed, `HttpOnly`, `Secure` cookie for that game
identity, 30 days. Next time the page offers "Continue as **PlayerName**" (with "Not me").

### When the player is not in game

Presence only knows connected players, and `/link` needs the player in game. For a buyer who is not
playing right now, two more things are tried, in this order, before asking them to join and type the
code:

1. **The remembered browser** (the cookie above).
2. **Confirmed addresses.** Each time a buyer confirms an identity ("Yes, that's me", or a code), SCRIPT//GO
   keeps the fingerprint of **that browser's** address against the identity: `HMAC-SHA256(historyKey,
   normalised address)`, where `historyKey` is a long-term secret held by the API only (never sent to
   game servers). Kept 60 days after the last confirmation from that address, at most 5 addresses per
   identity. Only confirmed pairs are kept: an address a player merely played from is never stored
   beyond presence.
   A later visit from a matching address, with exactly one identity behind it, is offered as
   "Continue as **PlayerName**?" with "Not me". Several identities, or none: the code.

The worst case of a wrong offer is a buyer paying for someone else in the same home, who sees the
name before paying. A player can clear their confirmed addresses ("Forget this browser and my
addresses" on the sign-in page, and from the account settings when signed in with an account).

## What the shop receives

- **Tebex webstore**, through "Sign in with SCRIPT//GO": the ID token's `sub` is an opaque, stable
  value derived from the game identity (never the raw identifier); `name` is the player's name.
  SCRIPT//GO keeps the mapping. When the payment webhook arrives, the signed-in identity says which
  player the perk is for.
- **Shop page on scriptgo.dev** (`/shop/<server>`): the same session; the checkout carries the
  identity like a purchase link does today.

## Privacy

- Addresses are personal data. Only keyed fingerprints leave the game server, kept while the player
  is connected; the key rotates daily. The operator turns presence on, and the operator's own notice
  to players must say so. SCRIPT//GO's privacy policy describes it.
- Address mode is the exception, and a separate choice of the operator: the address itself reaches
  the API over HTTPS, which fingerprints it at once and keeps only the fingerprint. Neither the SDK
  nor the API logs it or echoes it in an error. What changes is that the API sees the address in the
  request; as said below, the fingerprint never hid it from SCRIPT//GO.
- The page shows a name only to a browser whose address matched exactly one connected player, or one
  identity confirmed earlier from that address.
- Confirmed addresses (API-side fingerprints, never raw) are kept 60 days after the last confirmation,
  at most 5 per identity, and can be cleared by the player.
- A fingerprint is a pseudonym, not anonymity. Whoever holds the day's key can test candidate
  addresses against it: the IPv4 space is small enough to try in full. The key is held by SCRIPT//GO
  and by every server linked in that environment (it is the same for all of them, so fingerprints
  compare). So the fingerprint keeps raw addresses out of requests, the API's storage and logs; it
  does not hide an address from SCRIPT//GO, and a table of fingerprints that leaks with its day's
  key is as sensitive as the addresses.

## What Tebex documents, and what to confirm with Tebex

Documented (Tebex webhooks overview, 2026-11): a payment webhook's subject carries
`customer.username.id`, `customer.username.username` and `customer.ip`, and each of `products[]` its
own `username { id, username }`. The store is known on our side: each store has its own webhook
address. Webstores already require a sign-in before buying (game-server stores).

To confirm:

1. With "Sign in with SCRIPT//GO", what does Tebex put in `username.id` and `username.username`? We
   need our `sub` in `username.id` (or a field that carries it), so a payment names the player.
2. Does the sign-in request say which store it comes from? (Useful, not required: the identity is
   per environment.)

## What each adapter adds

The SDK core does the work once, for every platform: the presence module
(`sdk/lua/scriptgo/presence.lua`: normalisation, fingerprints, reports, removal, back-off) and the
`/link` command (registered by the host as soon as the server is linked; `scriptgo_link_command`,
`off` to remove it). An adapter gives it two optional things:

- **`adapter.players.address(player) -> "ip" | "ip:port" | nil`**, the `playerAddress(player)` of the
  design. The core drops the port. Without it, presence says `presence unavailable: this host cannot
  read a player's address`.
- **`adapter.crypto.hmacSha256(key, message) -> hex`**, from a vetted implementation of the host.
  The core never hashes by itself. Without it, presence reports only in address mode
  (`scriptgo_presence_addr`); otherwise it says `presence unavailable: no HMAC on this host`, and
  `/link` still works.

The host also gives the core its environment and adapter version, sent on every request.

| Platform | Address | HMAC | State |
|---|---|---|---|
| Standalone | simulated (`join 2 Bob @203.0.113.7`) | the `openssl` executable | presence and `/link` (tests and tooling); address mode when `openssl` is missing |
| Rust (Oxide/Carbon) | `player.net.connection.ipaddress` | .NET `HMACSHA256` in the bridge | presence and `/link`, unit-tested, not run on a Rust server |
| .NET kit, Lua guests | `IHostPlayerAddresses.Address(id)`, or `PlayerJoin(id, name, address)` | .NET `HMACSHA256` | presence and `/link`, in the resource that declares presence |
| OPEN//77 | `Open77.players.endpoint(id)` (`players.identity.sensitive`, asked by `pack` only for a resource that declares presence) | none in build 2.50.0+op77.208 | `/link`; presence in address mode only |
| Garry's Mod | `Player:IPAddress()` | none (`util.SHA256` only) | `/link` with `HTTP()`; presence in address mode only |
| Luanti | `core.get_player_ip(name)` | none | `/link` with http; presence in address mode only |
| BeamMP | `MP.GetPlayerIdentifiers(pid).ip` | none | `/link` with curl; presence in address mode only |
| FiveM | `GetPlayerEndpoint` | none | `/link`, and presence in address mode only, in a resource that declares presence (`pack` keeps the shim's section only there) |
| RedM | `GetPlayerEndpoint` | | no adapter yet |
| Hytale | none | | off |
| LÖVE, Godot, Neovim, CC: Tweaked | | | not applicable or no http |

Where the host has a hash but no HMAC (Garry's Mod, Luanti), building HMAC from SHA-256 in Lua
(RFC 2104) is possible but would be our own composition of a primitive: it is not done, by the rule
"vetted cryptography only". Address mode is the answer instead: the HMAC is then the API's.

Whether an environment's identifiers can be matched is the API's decision (`PLAYER_MATCH_ENVIRONMENTS`):
a host can report and still be refused with 409 `environment_not_matchable`. Only OPEN//77 and Rust
are matched in production today; the other rows say what the SDK does, not that the platform is
matched.

The capability is `presence` (`sdk/lua/scriptgo/capabilities.lua`), and
`sdk/conformance/sg_probe_presence` checks it on a host against `scriptgo verify --stub-api`.
