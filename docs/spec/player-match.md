# Finding a buyer's game identity

**Status: design, not built.** This page is the contract to build against. Nothing here runs yet.

A buyer on a seller's shop (their Tebex webstore, or a shop page on scriptgo.dev) has to be tied to a
player of a game server, so that a perk they pay for reaches the right player. They must not need a
SCRIPT//GO account, a link, or anything typed when it can be avoided. The platform does not matter:
it works wherever the SCRIPT//GO SDK runs, through the SDK alone.

## In plain words

1. While a player is connected, the SDK tells SCRIPT//GO "this player is here, from this address",
   as a keyed fingerprint of the address, never the address itself. It is forgotten when they leave.
2. The buyer signs in on the shop with "Sign in with SCRIPT//GO". Our page compares the fingerprint
   of the browser's address with the players connected right now.
3. **Found, exactly one:** the page shows "You are **PlayerName** on **Harbor City RP**?". One click
   on "Yes, that's me" and the shop knows the player.
4. **Not found, or more than one:** the page shows a short code and says "Type `/link K7-4QX` in
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

Every request carries the server link token (`perks.md`, "The protocol a game server speaks").

```
POST /v1/presence
{ "players": [ { "player": "<identifier>", "name": "PlayerName", "fp": ["<fingerprint>", ...] } ] }
```

- Sent when a player joins, then with the perks poll (every 30 s) for everyone still connected, and
  `DELETE /v1/presence/<identifier>` when they leave. An entry not refreshed for 2 minutes is gone.
- The fingerprint is `HMAC-SHA256(presenceKey, normalised address)`, hex. `presenceKey` is given by the
  API in each answer (`{ "presenceKey": "...", "rotatesAt": "..." }`), rotates daily, and is the same
  for every server link of an environment, so fingerprints from two servers compare. The raw address
  never leaves the game server.
- Normalisation: IPv4 as dotted quad; IPv6 as its `/64` prefix (privacy addresses change inside it);
  an IPv4-mapped IPv6 address as IPv4. The port is dropped.
- SCRIPT//GO keeps only `{ environment, identifier, name, server link, fingerprints, lastSeen }`, in
  memory or a short-lived table, never in logs.

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
POST /v1/identity/codes            (from the sign-in page)  ->  { "code": "K7-4QX", "expiresAt": ... }
POST /v1/identity/codes/confirm    (from a game server, server link token)
{ "code": "K7-4QX", "player": "<identifier>" }
```

- Six characters from an unambiguous alphabet, one use, 10 minutes, bound to the browser session
  that asked for it. Rate limited per session, per address and per server link.
- The SDK registers the command (`scriptgo_link_command`, default `link`) and calls `confirm` for the
  player who typed it. The player sees "Linked: you can go back to your browser." The page, polling
  the code's state, continues on its own.
- The identity confirmed is the player the game server authenticated; the code only carries it.

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
- The page shows a name only to a browser whose address matched exactly one connected player, or one
  identity confirmed earlier from that address.
- Confirmed addresses (API-side fingerprints, never raw) are kept 60 days after the last confirmation,
  at most 5 per identity, and can be cleared by the player.

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

One optional host function: `playerAddress(player) -> "ip" | nil`. OPEN//77:
`Open77.players.endpoint(id)` (strip the port; needs `players.identity.sensitive`). FiveM / RedM:
`GetPlayerEndpoint`. Garry's Mod: `Player:IPAddress()`. Rust (Oxide/Carbon):
`player.net.connection.ipaddress`. The SDK core does the rest (fingerprints, presence, the `link`
command), once for every platform.
