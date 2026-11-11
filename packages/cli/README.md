# @scriptgo/cli

The `scriptgo` command line: create, test, verify, pack, publish and install SCRIPT//GO resources.
It runs on Node.js 22 or later.

```bash
npm install -g https://github.com/scriptgo-hq/scriptgo-sdk/releases/download/v0.1.5/scriptgo-cli-0.1.5.tgz
scriptgo --help
```

The package is one bundled file plus the SDK's Lua core, adapters and first-party packages. It
talks to `https://api.scriptgo.dev`; `--api <url>` or `SCRIPTGO_API` points it at another API, a
local one in development for example. `test`, `run` and `verify` also need a Lua interpreter
(`lua`, `lua5.4` or `luajit`) on the `PATH`.

Part of the [SCRIPT//GO SDK](https://github.com/scriptgo-hq/scriptgo-sdk). Documentation:
[scriptgo.dev/docs/cli](https://scriptgo.dev/docs/cli). MIT licence.
