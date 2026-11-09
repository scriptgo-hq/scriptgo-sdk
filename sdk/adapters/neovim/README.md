# Neovim adapter (`neovim`)

Runs SCRIPT//GO resources inside [Neovim](https://neovim.io) as an ordinary plugin. The server side
and the local client (player `1`, the person at the keyboard) both run in the editor process, on the
same portable host as every other environment (`sdk/lua/scriptgo`); events between them are looped
back through the value codec, so isolation rules are the ones of a real network. A libuv timer
ticks the host on Neovim's main loop, so `Wait`, timers and promises behave as in a game loop and
the editor never blocks.

| File | Role |
|---|---|
| `lua/scriptgo_nvim/adapter.lua` | The adapter the host calls: clock, logging, files, storage, notifications, permissions, config, HTTP |
| `lua/scriptgo_nvim/init.lua` | What a user's config calls: `setup()`, the `:ScriptGo` command, the timer |
| `plugin/scriptgo.lua` | Registers `:ScriptGo`; nothing else is loaded until it is used |
| `lua/scriptgo_nvim/verify.lua`, `verify.lua` | Headless verification mode (`nvim --headless --clean -l verify.lua`) |
| `test/plugin_test.lua` | Smoke test of the plugin as a person uses it |

What the adapter maps:

| Capability | Neovim |
|---|---|
| clock | `vim.uv.hrtime()` |
| `storage` | `stdpath("data")/scriptgo/storage/<resource>.json` (and `<resource>.client.json`) |
| `ui` | `vim.notify` for the local player and for `-1`, and logged; a headless editor only logs them |
| `commands` | `:ScriptGo <command> [args]` runs a resource command as the local player |
| `permissions`, `config` | the `config` table given to `setup()` (below) |
| `players` | the single local player, id `1`, named after the OS user unless `player` is given |
| `http`, `licensing` | `curl` through `vim.system`, asynchronous; unavailable without curl or before Neovim 0.10, and `licensing` follows `http` |

## Installing

The plugin is this folder. It needs the core next to it: in the SDK checkout it finds
`sdk/lua/scriptgo` by itself; elsewhere, copy `sdk/lua/scriptgo` to `lua/scriptgo_nvim/core/`, or
point `vim.g.scriptgo_core` (or `setup{ core = ... }`) at it.

With [lazy.nvim](https://github.com/folke/lazy.nvim), from a local checkout:

```lua
{
  dir = "~/scriptgo/sdk/adapters/neovim",
  config = function()
    require("scriptgo_nvim").setup({
      search = { vim.fn.expand("~/scriptgo/resources") },   -- folders holding resources
      resources = { "sg_inventory" },                        -- started at setup
      config = {
        permissions = { ["1"] = { "*" } },                   -- the local user may do everything
        resources = { inventory_pro = { license_key = os.getenv("INVENTORY_PRO_KEY") } },
        convars = { scriptgo_api = "https://api.example" },  -- the SCRIPT//GO API
      },
    })
  end,
}
```

Without a plugin manager, add the folder to `runtimepath` and call `setup` the same way.

### `setup(options)`

| Option | Meaning |
|---|---|
| `resources` | names found in `search`, or folders; each is added with its dependencies and started |
| `search` | folders holding resources by name |
| `config` | `permissions`, `resources`, `convars`, `http = false`: the standalone config shape, or its JSON text |
| `storageDir` | where storage files go (default `stdpath("data")/scriptgo/storage`) |
| `player` | `{ id, name }` of the local player (default id `1`, the OS user name) |
| `notify` | send notifications to `vim.notify` (default: when the editor has a UI) |
| `tickMs` | timer period (default 10 ms; Windows timers round it up to about 15 ms) |
| `autoStart`, `logLevel`, `quiet`, `logSink`, `curl`, `http`, `budgetMs`, `core` | as for the other adapters |

`setup` returns the instance; `require("scriptgo_nvim").instance` is the current one. Calling
`setup` again shuts the previous one down. Everything stops on `VimLeavePre`.

### `:ScriptGo`

| Command | Does |
|---|---|
| `:ScriptGo` or `:ScriptGo status` | each resource and its state |
| `:ScriptGo log` | the last 1000 log lines in a scratch buffer |
| `:ScriptGo add <dir>` | adds a resource folder (and its dependencies) and starts it |
| `:ScriptGo start <name>`, `:ScriptGo stop <name>` | starts or stops a loaded resource |
| `:ScriptGo <command> [args]` | anything else is a resource command, run as the local player (`:ScriptGo giveitem 1 water 2`) |

## Verification mode

```sh
nvim --headless --clean -l sdk/adapters/neovim/verify.lua --scriptgo-verify <resourceDir> \
     [--search <dir>]... [--report out.json] [--settle 2000] [--with <exampleDir>] [--config config.json]
```

`scriptgo verify <dir> --env neovim` runs exactly this, with the binary from `--nvim`,
`SCRIPTGO_NVIM` or `tools/runtimes/neovim`, and turns the report into a `CompatibilityRun`.
`--clean` keeps the user's own config and plugins out of the run. The resource starts through the
same `scriptgo_nvim.new()` a user gets, and the plugin's own timer ticks it while `vim.wait` runs
Neovim's event loop for the settle time. Checks are those of the LÖVE mode: `manifest_valid`,
`environment_declared`, `dependencies_resolved`, `starts`, `export:<name>`, `readme_example`,
`no_runtime_errors`, one `self:<name>` per `SGCHECK` line, then `tests` on Neovim's LuaJIT. With
`--stub-api`, the resource's license calls go over curl to the schema-checked stub and the report
adds the `api:*` checks.

The plugin itself (`setup`, `:ScriptGo`, `vim.notify`, storage, refusals) is covered by:

```sh
nvim --headless --clean -l sdk/adapters/neovim/test/plugin_test.lua
```

## Measured

Neovim 0.12.6 (LuaJIT 2.1) on Windows 11, headless. See `TEST_RESULTS.md` for the runs.

## Limitations

- Single user: no real network between the server and the client side.
- HTTP, and so online license checks, needs curl and Neovim 0.10 or later (`vim.system`).
- Only Windows has been measured; macOS and Linux use the same Neovim API but are not measured yet.
- The Lua sandbox is not a security boundary: install resources you chose, as for any plugin.
