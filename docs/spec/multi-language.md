# Several languages, one runtime

A resource may be written in Lua, in JavaScript, or in TypeScript (compiled to JavaScript), and one
resource may mix them. Every language sees the same runtime ([runtime.md](runtime.md), contract in
[runtime-idl.json](runtime-idl.json)); only the idioms differ. This document fixes what happens
when values, events and export calls cross from one language to another. It describes the .NET
kit (`sdk/dotnet/ScriptGo.Host`), the only kit that runs more than one language today; the
portable Lua core follows the same rules for Lua.

C# guests are planned for phase 3 and do not exist: a manifest that lists a `.cs` script is
refused (`unsupported_script`).

## Guests

- Each resource side (server, client) gets one guest VM **per language its scripts use**: a Lua
  state (KeraLua, Lua 5.4) and/or a JavaScript engine (Jint). Two resources never share a VM, and
  the two VMs of one resource side do not share globals either.
- A script's language comes from its extension: `.lua` is Lua; `.js` and `.ts` are JavaScript.
  Scripts run in manifest order (`shared_scripts`, then the side's scripts, then the
  `environment_scripts` of the current environment), each in the VM of its language.
- A host that has no guest for a language a resource uses refuses to start it with
  `language_unavailable:<language>@<environment>` (the portable Lua core runs Lua only).
- Everything that leaves a VM goes through the host bridge, where the codec copies it. Guests never
  hold references to each other's objects.
- Declarative exports (`exports` / `server_exports` in the manifest) are global functions of that
  name, looked up in each VM of the side after the side's last script; none found fails the start
  with `manifest_export_missing:<name>`.

## TypeScript

The CLI compiles each `.ts` script entry of the manifest (globs expanded) with esbuild 0.25.12 into
`<entry>.js` (`server/main.ts` → `server/main.ts.js`): one bundle per entry, format IIFE, target
ES2022, platform neutral. The entry's relative imports are bundled in; an import that reads a file
outside the resource fails (`typescript_import_outside_resource`), and any esbuild error fails
with `typescript_compile_failed`. Entries share nothing except through the runtime (events,
exports). esbuild strips types without checking them: type errors are `tsc --noEmit`'s job.

The source folder is not changed. `scriptgo pack` adds each `<entry>.js` to the archive next to
its `.ts` (with the sources the bundle read); `scriptgo verify` writes them into the copy it runs.
The manifest keeps naming the `.ts` file. A host loads the compiled `<entry>.js` and fails the
start with `typescript_not_compiled:<entry>` when it is missing. A glob in the manifest does not
pick up a `<entry>.ts.js` that sits next to its `.ts`. There is no `require` in JavaScript at run
time: modules are resolved when the entry is compiled.

Typings for resource authors are in `@scriptgo/types` (`packages/types`), generated from the IDL.
A resource's `tsconfig.json` uses `"lib": ["ES2022"]` and `"types": ["@scriptgo/types"]`, without
the DOM or Node typings: the runtime has neither.

## Idioms

| | Lua | JavaScript / TypeScript |
|---|---|---|
| Wait | `Wait(100)` suspends the coroutine; only inside a thread | `await Wait(100)`: `Wait` returns a promise |
| `CreateThread(fn)` | runs `fn` in a coroutine until its first yield | calls `fn` now (usually `async`); continuations run on later ticks |
| Failure of a call | `nil` (or `false`) followed by the reason; misuse raises | throws `ScriptGoError` with `code` = the reason; promises reject with one; misuse throws `TypeError` |
| Several results | multiple returns | an export returns `ScriptGo.values(a, b)`; callers get the first value from `exports.res.name()` and all of them from `ScriptGo.exports.invoke` |
| Export call syntax | `exports.res:name(...)` (colon) | `exports.res.name(...)` |
| `source`, `GetInvokingResource()` | kept per thread: still valid after `Wait` | valid in the synchronous part of a handler, command or export: read them before the first `await` |
| Asynchronous host calls | `ScriptGo.http.request` and `ScriptGo.licensing` wait inside the thread; `ScriptGo.exports.call` returns a promise (`p:await()`) | all return promises |
| JSON null | `ScriptGo.json.null` (a sentinel) | `null` |
| Only in this language | `require`, `Citizen`, `promise.new`, the `Open77` alias, `ScriptGo.runtime.luaVersion` | `setTimeout`/`clearTimeout`, `console`, `ScriptGoError`, `ScriptGo.values`, `ScriptGo.exports.invoke`, `ScriptGo.natives.invoke` |

`print` joins its arguments with a tab in both languages; `console.log` joins them with a space.
`ScriptGo.runtime.language()` answers `"lua"` or `"js"`.

## Value codec

Every value that crosses a boundary (an event, an export call, a native call, storage, a host
call) is copied. Rules, identical whatever the two languages are:

- **Kinds**: nil, booleans, integers, finite numbers, strings, and acyclic tables with string or
  integer keys.
- **Numbers**: Lua integers stay integers. A JavaScript number with no fractional part within
  ±2^53 becomes an integer; any other number a float. So a Lua float such as `1.0` that goes
  through JavaScript comes back as the integer `1`, and an integer beyond ±2^53 reaches JavaScript
  as the nearest double. NaN and infinities are refused (`codec: non-finite number`).
- **Strings**: bytes in Lua, text in JavaScript, copied as UTF-8. Bytes that are not valid UTF-8
  reach JavaScript as U+FFFD.
- **Lua table → JavaScript**: a table whose keys are exactly `1..n` becomes an array; an **empty
  table becomes an empty array**; any other table becomes a plain object, integer keys written as
  decimal strings. Object keys arrive sorted: integers ascending, then strings in ordinal order, so
  the same table always gives the same property order. A table holding both `1` and `"1"` cannot
  be one JavaScript object: the string key, written last, wins.
- **JavaScript → Lua**: an array becomes a sequence (index `i` → key `i + 1`; holes and `undefined`
  are nil, so `[1, , 3]` arrives as `{ [1] = 1, [3] = 3 }`, which goes back to JavaScript as the
  object `{ "1": 1, "3": 3 }`). A plain object (an object literal or `Object.create(null)`) becomes
  a table: own enumerable data properties only, `undefined` and `null` values dropped, keys that
  are canonical integers (`"0"`, `"17"`, `"-3"`) become integer keys. `{}` goes back to
  JavaScript as `[]`. Only the indices of an array are read, not other properties set on it.
- **Refused, with a reason**: functions; Lua threads and userdata; JavaScript symbols, bigints,
  class instances, `Map`, `Date`, promises, proxies and accessor properties; keys other than
  strings and integers; cycles (`codec: cyclic table`); more than 32 levels of nested tables
  (`codec: value nested deeper than 32`); more than 1 MiB of encoded data
  (`codec: value exceeds 1 MiB`). Reading a JavaScript value never runs script code (no getters,
  no proxy traps).
- When an argument is refused, the call fails with the operation's token:
  `event_payload_not_serializable`, `export_arguments_not_serializable`,
  `export_result_not_serializable`, `native_arguments_not_serializable`, or the codec reason
  itself (storage).
- Storage and JSON (`ScriptGo.json.encode`) write object keys sorted; sequences and empty tables
  are JSON arrays.

The conformance vectors in [`sdk/conformance/vectors/codec.json`](../../sdk/conformance/vectors/codec.json)
pin these rules down case by case (a Lua and/or JavaScript expression, and the value or refusal it
must give). The portable Lua core runs them on every interpreter (`sdk/lua/spec/codec_vectors_spec.lua`);
the .NET kit runs them through its Lua and JavaScript guests and crosses every accepted value into
the other language and back (`CodecVectorTests`).

## Events

- Handlers are kept per resource side, in registration order, **across languages**: a Lua handler
  and a JavaScript handler for the same event in one resource run in the order they were added.
  A Lua handler runs in a new thread; a JavaScript handler is called directly.
- **Server `TriggerEvent`** is the host-wide bus: queued to the next tick, then delivered to every
  started resource **in resource-name order**, without `source`. **Client `TriggerEvent`** stays
  inside the calling resource side and runs now.
- **Network events** reach only the names a side registered with `RegisterNetEvent`.
  `TriggerServerEvent` (client) and `TriggerClientEvent(name, target)` (server; `-1` for every
  player) are queued to the next tick; on the server, `source` is the sending player. The .NET kit
  runs both sides in one process with one local player: a host that runs only one side answers
  `network_unavailable`, and a client target other than `-1` or the local player is accepted and
  delivered nowhere.
- **Host events** (`onResourceStart`, `onResourceStop`, `onClientResourceStart`,
  `onClientResourceStop`, `playerJoining`, `playerDropped`, `onPlayerConnected`,
  `onPlayerDisconnected`) are delivered at once to every started (or starting) resource, in
  resource-name order. `playerJoining` and `playerDropped` carry the player in `source`.
- Each handler receives its own copy of the arguments.

## Exports

- `exports(name, fn)` publishes an export of the resource side, whatever its language; one name per
  side (registering it again replaces it). A resource may call its own exports, which is how its
  Lua and JavaScript code call each other.
- **Synchronous calls** (`exports.res:name(...)` in Lua, `exports.res.name(...)` and
  `ScriptGo.exports.invoke` in JavaScript) run the export now and return its results. The export
  must finish without waiting: a Lua export that calls `Wait`, or a JavaScript export that returns
  a promise, fails with `export_yielded`. Other failures: `export_resource_unavailable` (not
  started, or no such side), `export_not_found`, `export_recursion_limit` (more than 32 nested
  synchronous calls), and the export's own error message. In Lua a failure raises
  `export res:name <reason>`; in JavaScript it throws `ScriptGoError(reason)` with that message.
- **Asynchronous calls** (`ScriptGo.exports.call(res, name, ...)`) run the export in its own
  thread on the provider's side, so it may wait. The caller gets a promise (Lua: `p:await()` inside
  a thread gives the values or `nil, reason`; JavaScript: `Promise<unknown[]>` of every value). It
  settles on the caller's next tick. Failures: `export_resource_unavailable`, `export_not_found`,
  `export_failed: <message>`, `export_result_not_serializable`, and `export_target_stopped` when
  the provider stops first.
- Inside an export, `GetInvokingResource()` is the calling resource. The provider does not inherit
  the caller's `source`.
- **File scope**: while a resource is still loading, a synchronous export call from file scope
  fails with `resource_preparing` in both languages, and so does Lua's `ScriptGo.exports.call`
  (`nil, "resource_preparing"`). JavaScript's `ScriptGo.exports.call` is not refused there. Calls
  belong in `CreateThread`, a handler or `onResourceStart`.

## Native modules

An integrator adds its own natives by describing them once as a native module
([native-module.schema.json](native-module.schema.json)) and binding a handler to each function
(`ScriptGoHost.RegisterNativeModule`). Every guest started afterwards sees them as
`ScriptGo.natives.<module>.<function>(...)`, and as a global `<module>` when the module sets
`global` (not for names the runtime uses).

- Before the handler runs, the kit checks, in order: the function exists
  (`native_not_found:<module>.<function>`), its `side` allows the caller's side
  (`native_unavailable_on_side:<side>`), and its `permission`, when it has one, is both **declared
  in the resource's manifest** and **granted by the host** (`HostOptions.GrantPermission`,
  default: grant) (`permission_denied:<permission>`). Then the arguments: no more non-nil
  arguments than declared (`invalid_argument_count`), each matching its type
  (`invalid_argument:<name>`).
- Arguments and results go through the codec. A handler refuses a call by throwing
  `NativeException(code)`; the guest sees that code. Any other exception is logged and answers
  `native_failed`.
- Lua answers every result (`true` when the native returns none) or `nil, reason, detail`.
  JavaScript answers the first result (`undefined` when none) or throws `ScriptGoError(reason)`
  whose `detail` is that same detail (the codec message, `expected string, got integer`, a
  `NativeException`'s message); `ScriptGo.natives.invoke(module, function, ...)` answers every
  result as an array. So no module
  may be named `invoke`.
- A module may set an extension capability (`x-...`) that the host gains when registering it, so
  manifests can require it.
- `NativeModule.ToTypeScript()` and `ToLuaAnnotations()` generate the module's typings; the
  TypeScript declarations merge into the `ScriptGoNatives` namespace that `@scriptgo/types`
  declares, which types `ScriptGo.natives`.

## Quotas

Each resource side has its own limits (defaults of the .NET kit, `HostOptions.Quotas`):

| Limit | Default | Past it |
|---|---|---|
| Lua instructions | 1,000,000 per entry | the running thread raises `quota_exceeded:instructions`; the resource keeps running |
| Lua heap | 64 MiB per state | allocations fail inside the guest; the resource stops, state `failed`, `quota_exceeded:memory` |
| JavaScript statements | 1,000,000 per entry | the entry is abandoned, `quota_exceeded:instructions`; the resource keeps running |
| JavaScript wall time | 2 s per entry | as above, `quota_exceeded:time` |
| JavaScript allocation | 64 MiB per entry | as above, `quota_exceeded:memory` |
| JavaScript call depth | 256 | the entry is abandoned (`recursion limit`) |
| Threads | 1,024 | `quota_exceeded:threads` (Lua coroutines; pending JavaScript timers and `Wait`s) |
| Event handlers | 2,048 | `quota_exceeded:handlers` |
| Exports | 256 | `quota_exceeded:exports` |
| Queued events | 4,096 host-wide | `event_queue_limit` until the next tick |
| Nested synchronous exports | 32 | `export_recursion_limit` |

- **Budgets are per host-level entry.** The host counts its entries into guest code from outside
  (a guest's tick, one event delivery, a host call); a resource side gets a fresh budget the first
  time it runs in such an entry. Every nested call in the same entry, including synchronous export
  calls from other resources and other languages, draws on what is left. So a resource that calls
  another resource's export in a loop cannot hand it a fresh budget each time; once a side's budget
  is spent, further calls into it in the same entry fail at once.
- A limit reached while a script file runs (at load) fails the resource start with that reason, in
  both languages.
- **Lua**: a count hook (every 10,000 instructions, or 1,000 when the budget is under 100,000)
  raises in the resource's thread; `pcall` and `xpcall` re-raise it, so a script cannot swallow it.
  The thread dies and the failure is logged once with its traceback; other threads run on the next
  tick. The heap cap is enforced by the state's allocator; after an entry that hit it (or is still
  over it after a full collection), the resource stops. `__gc` metamethods are refused (finalizers
  would run outside any budget) and the string metatable is locked.
- **JavaScript**: the limits are checked by the kit's own engine constraint (statements on every
  step; time and allocation every 1,024 statements). Past a limit, the kit throws a host exception
  that neither `catch` nor `finally` can run code after; the whole entry is abandoned, the engine's
  call stack and the runtime's context are reset, and promise jobs still queued run in the next
  entry. Call depth past the limit abandons the entry the same way. The allocation limit counts
  .NET allocations on the host thread during the entry, the host's own copying included: it bounds
  growth per entry, not the live heap. `eval` and `new Function` are disabled; regular expressions
  time out with the wall-time budget; arrays are capped at 16,000,000 elements.
- The portable Lua core has no instruction or memory cap; an adapter may set an execution time
  budget per resume (`budgetMs`).

## Failure tokens

Reasons are short tokens, sometimes with a detail after a colon (`capability_unavailable:http@love2d`,
`module_not_found:util`). They are the same in every language: the value Lua returns after
`nil`/`false`, and the `code` of the `ScriptGoError` JavaScript throws. The full list is the
`errors` table of [runtime-idl.json](runtime-idl.json).
