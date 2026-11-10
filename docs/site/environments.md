---
title: Environments and statuses
description: What an environment is, how it earns its status from real runs, and how to read the directory, the protection view and the capability matrix.
order: 4
---

An environment is a place where SCRIPT//GO scripts run. The [directory](/environments) lists every
one of them with its status; this page says how to read it.

## Two kinds

- **Engines and runtimes** run the scripts themselves: the scripts run inside the engine or the
  runtime.
- **Mod platforms** are multiplayer and modding layers that run on top of an existing game. Players
  bring their own copy of the game; the platform's servers and clients load the packages.

Every environment is a peer. The directory sorts them by status, then by name.

## Languages

Every environment runs Lua, on the host's own Lua (5.1 to 5.4 or LuaJIT, depending on the host).
The .NET kit also runs TypeScript and JavaScript. C# is planned. See
[Languages](/docs/sdk#languages).

## Statuses

| Status | What it means |
|---|---|
| Available | The adapter is stable and the conformance suite passes |
| Beta | The adapter is usable; conformance is partial |
| Experimental | Integration tests or a review are still pending. Expect changes, and do not rely on it for production |
| Planned | Not usable yet. A planned environment has no install steps |

A planned environment also shows the state of its adapter:

| Adapter state | What it means |
|---|---|
| Real run passed | At least one package passed `scriptgo verify` in the real runtime |
| Adapter written | The adapter code exists and passes its own tests, but no run in the real runtime has passed yet. The page says what that run is waiting for |
| Not started | No adapter code has been written yet. The summary on the page is the intended approach |

## How a status is earned

A status comes from the adapter's conformance runs, never from a form. `scriptgo verify` starts a
package and its README example in the real runtime and writes a report; statuses and package
badges are read from those reports.

Tests against mocks, stubs, emulators or a plain VM do not count as a run, and they never write a
report. The "Proven on a real runtime" table on each environment page lists the runs that do
count, with the runtime version, the number of checks and the date. The status moves past planned
only after a real run passes. See [Conformance](/docs/create-adapter#conformance).

## The protection view

The Protection view of the directory says what a buyer's server gets on each host:

- **Code escrow** needs a host that runs compiled code and can hold a key. An encrypted release is
  decrypted in memory, for a licensed and bound server only.
- **Licence and signing**: a host that runs plain script gets a licence check and signed releases,
  and no code-secrecy claim.
- **No licence check**: the adapter has no licence check. Releases are still signed.

"Planned" means the tier does not work there yet. Each environment page carries the registry's own
sentence for that host. See [the tiers](/docs/protect-your-work#tiers).

## Paid mods: the platform's rule

A script is sold as a SCRIPT//GO script that runs on environments. No environment allows or
forbids a sale on SCRIPT//GO.

A platform may still have its own rule about paid mods, set by the rights holder of the game it is
built on. Each environment page notes what that rights holder says. It is the platform's rule, not
ours: whoever runs a script on that platform answers for following it. See
[the rules](/docs/selling#the-rules).

## The capability matrix

The matrix shows, for each environment, whether the adapter provides each capability:

| Support | What it means |
|---|---|
| Supported | Fully provided by the adapter |
| Partial | Provided with limitations |
| Fallback | Degrades to a simpler behaviour, for example log output |
| Not available | The environment does not provide it |

Each cell has a note from the adapter's capability registry. A package that requires a capability
an environment lacks does not start there. See
[SDK and capabilities](/docs/sdk/capabilities).

## Your platform is not listed

One adapter brings every package to it. See [Create an adapter](/docs/create-adapter).
