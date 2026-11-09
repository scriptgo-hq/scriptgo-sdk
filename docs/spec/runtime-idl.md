# Runtime IDL (`runtime-idl.json`, version 1)

[`runtime-idl.json`](runtime-idl.json) is the language-neutral contract of the SCRIPT//GO runtime:
every global, namespace member and host event a resource can use, with its parameters, results,
failure tokens and the way each guest language binds it. It describes what the kits implement
today (`sdk/lua/scriptgo` and `sdk/dotnet/ScriptGo.Host`); [runtime.md](runtime.md) is the prose
guide and [multi-language.md](multi-language.md) the semantics across languages.

Typings are generated from it: `node tools/gen-types.mjs` writes `packages/types/index.d.ts`
(`@scriptgo/types`), and `--check` fails when that file is stale. The package's tests also check
that every name the IDL lists exists in the .NET kit's guest preludes, so the contract and the
implementation cannot drift apart silently.

## Shape

One JSON object:

| Key | Holds |
|---|---|
| `idl` | Format version (`1`) |
| `runtime` | The runtime API version it describes (`ScriptGo.runtime.version()`) |
| `sides` | `server`, `client` |
| `languages` | `lua`, `js` (implemented), `cs` (`reserved`: phase 3, no bindings). Per language: script extensions, how failures surface, the sandbox, and for `js` the TypeScript rule and the preamble the typings start with |
| `kits` | The host kits and the languages each runs. A member with a `kits` list exists only in those kits |
| `capabilities` | The capability names and what each covers |
| `types` | Named types (below) |
| `errors` | Every failure token a call can answer, with placeholders in `<...>` |
| `globals` | Global functions and values |
| `namespaces` | `ScriptGo` and its sub-namespaces (`ScriptGo.storage` ...), each with `members` |
| `events` | Events the host emits: name, side, arguments, and whether `source` carries the player |
| `codec` | Limits and rules of the value codec |
| `quotas` | Per-resource limits, with the defaults of the .NET kit |

## Members

A global or namespace member:

```json
{
  "name": "TriggerClientEvent",
  "kind": "function",
  "sides": ["server"],
  "capability": "storage",
  "kits": ["dotnet"],
  "languages": ["lua"],
  "doc": "What it does, the same in every language.",
  "params": [{ "name": "target", "type": "PlayerId" }, { "name": "args", "type": "value..." }],
  "returns": ["boolean"],
  "errors": ["invalid_target", "event_queue_limit"],
  "lua": { "failure": "false_reason", "doc": "Lua-specific note." },
  "js": { "failure": "throw", "returns": ["promise<value[]>"], "doc": "JavaScript-specific note." }
}
```

- `kind`: `function`, `value` (with `type`), `class` (JavaScript classes: `params` for the
  constructor, `fields`), `alias` (`of`: the global it is another name for), `exports` and
  `natives` (shapes no type expression covers; their bindings give the declaration).
- `sides`, `capability`, `kits`, `languages`: omitted means every side, no capability check, every
  kit, every language. A namespace may set `capability`, `sides` and `kits` for all its members.
  `capability` means the call fails with `capability_unavailable:<capability>@<environment>` when
  the host lacks it.
- `returns` lists the results of a successful call; failures are in `errors` and in the binding's
  `failure`.
- Bindings (`lua`, `js`) say how a language departs from the neutral contract:
  - `failure`: `raise` (Lua error), `nil_reason` (`nil, reason`), `false_reason` (`false, reason`),
    `nil_code_body` (`nil, code, body`), `throw` (JavaScript `ScriptGoError` whose `code` is the
    token, or a `TypeError` for misuse), `reject` (a promise rejected with a `ScriptGoError`);
  - `returns`: the results in that language when they differ (a promise in JavaScript, a Lua
    promise object);
  - `signature` / `declarations` / `type`: the TypeScript text, only where the generator cannot
    derive it (`exports`, `console`, `ScriptGo.natives`, `ScriptGo.json.null`);
  - `doc`: a note for that language.

## Type expressions

`nil`, `boolean`, `integer`, `number`, `string`, `table`, `value` (any value the codec copies),
`any` (anything, for calls that never copy, such as `print`), a name from `types`, and:

| Form | Meaning |
|---|---|
| `T?` | `T` or nil |
| `T[]` | a sequence of `T` |
| `map<T>` | a table with string keys and `T` values |
| `promise<T>` | a JavaScript promise of `T` (bindings only) |
| `A\|B` | either |
| `T...` | any number of `T`, last parameter or result only |

Named types have a `kind`: `primitive`, `alias` (`type`), `enum` (`values`), `record` (`fields`,
`open: true` when other keys are allowed), `callback` (`params`, `returns`) and `opaque` (a value
only the runtime builds, such as a Lua promise or the result of `ScriptGo.values`).

In the TypeScript typings, a `value` the resource passes in is `unknown` (the codec checks it at
run time) and a `value` it receives is `any`; `table` is `SgTable`; named types are prefixed with
`ScriptGo` (`ScriptGoHttpRequest`).

## Extending it

1. Implement the member in every kit that claims it (the guest preludes of `sdk/dotnet` and the
   portable core in `sdk/lua/scriptgo`), or list the kits that have it in `kits`.
2. Add it to `runtime-idl.json`, with its failure tokens in `errors` and a binding for any
   language that departs from the neutral form.
3. Run `node tools/gen-types.mjs` and commit `packages/types/index.d.ts`.
4. Bump `runtime` (and `scriptgo_version` ranges in the docs) when resources can see the change.
   A new key in this file that older generators would misread is a new `idl` version.

A C# binding will be added with the C# guests (phase 3), as a `cs` binding on each member.
