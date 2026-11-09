-- Smoke test of the Neovim plugin as a person uses it: setup(), the :ScriptGo command, resource
-- commands typed in the editor, vim.notify, storage, stop. Runs in a real Neovim:
--
--   nvim --headless --clean -l sdk/adapters/neovim/test/plugin_test.lua [sdkPackagesDir]
--
-- Prints one `ok|FAIL <name>` line per check and exits 1 on any failure.
local here = vim.fs.normalize(debug.getinfo(1, "S").source:sub(2)):match("^(.*)/")
local plugin = vim.fs.normalize(here .. "/..")
vim.opt.runtimepath:prepend(plugin)
vim.cmd("runtime plugin/scriptgo.lua")
local packages = vim.fs.normalize(_G.arg[1] or (plugin .. "/../../packages"))

local failures, total = 0, 0
local function check(name, ok, detail)
    total = total + 1
    if not ok then failures = failures + 1 end
    io.stdout:write(("%s %s%s\n"):format(ok and "ok  " or "FAIL", name, detail and detail ~= "" and ("  " .. detail) or ""))
end

-- Everything sent to vim.notify, newest last.
local notes = {}
vim.notify = function(msg, level) notes[#notes + 1] = { msg = tostring(msg), level = level } end
local function lastNote(pattern)
    for i = #notes, 1, -1 do if notes[i].msg:find(pattern) then return notes[i] end end
    return nil
end
local function settle(ms) vim.wait(ms or 300, function() return false end, 10) end

check("command_registered", vim.fn.exists(":ScriptGo") == 2)

local storage = vim.fs.normalize(vim.fn.tempname()) .. "-sg"
local sgn = require("scriptgo_nvim")
local sg = sgn.setup({
    search = { packages }, resources = { "sg_inventory" }, storageDir = storage, notify = true, quiet = true,
    player = { id = 1, name = "Ada" },
    config = { permissions = { ["1"] = { "inventory.give" } } },
})
settle()
check("timer_ticks", sg.ticks > 5, sg.ticks .. " ticks")

vim.cmd("ScriptGo status")
local status = lastNote("sg_inventory")
check("status_lists_resource", status ~= nil and status.msg:find("sg_inventory%s+started") ~= nil, status and status.msg:gsub("\n", " | ") or "no notification")

vim.cmd("ScriptGo giveitem 1 water 2")
settle()
local gave = lastNote("Gave")
check("server_command_as_local_player", gave ~= nil and gave.msg:find("Gave 2 x water to 1", 1, true) ~= nil, gave and gave.msg or "no notification")

vim.cmd("ScriptGo inventory")
settle()
local inv = lastNote("kg")
check("client_command_sees_server_state", inv ~= nil and inv.msg:find("x2") ~= nil, inv and inv.msg or "no notification")

vim.cmd("ScriptGo stop sg_inventory")
settle(100)
check("stop_from_editor", sg.host:resourceState("sg_inventory") ~= "started", tostring(sg.host:resourceState("sg_inventory")))
local files = {}
for name in vim.fs.dir(storage) do files[#files + 1] = name end
check("storage_written", #files > 0, table.concat(files, ", "))

vim.cmd("ScriptGo log")
local logBuf = vim.api.nvim_buf_get_lines(0, 0, -1, false)
check("log_buffer", vim.bo.buftype == "nofile" and table.concat(logBuf, "\n"):find("Gave 2 x water", 1, true) ~= nil, #logBuf .. " lines")
vim.cmd("close")

-- A second setup replaces the first; without the privilege the command is refused.
notes = {}
sg = sgn.setup({ search = { packages }, resources = { "sg_inventory" }, storageDir = storage, notify = true, quiet = true })
settle()
vim.cmd("ScriptGo giveitem 1 water 1")
settle()
local refused = lastNote("may not")
check("refused_without_privilege", refused ~= nil and refused.level == vim.log.levels.ERROR, refused and refused.msg or "no notification")

sg:shutdown()
vim.fn.delete(storage, "rf")
io.stdout:write(("%d/%d checks passed\n"):format(total - failures, total))
io.stdout:flush()
os.exit(failures == 0 and 0 or 1)
