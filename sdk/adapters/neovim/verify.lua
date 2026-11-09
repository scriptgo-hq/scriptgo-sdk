-- Entry point for `nvim --headless --clean -l sdk/adapters/neovim/verify.lua --scriptgo-verify <dir> ...`.
-- Puts this plugin on the runtimepath (--clean starts without the user's config and plugins), runs
-- the verify mode (lua/scriptgo_nvim/verify.lua) and exits with its code.
local here = vim.fs.normalize(debug.getinfo(1, "S").source:sub(2)):match("^(.*)/")
vim.opt.runtimepath:prepend(here)
local ok, code = xpcall(function() return require("scriptgo_nvim.verify")(_G.arg or {}) end, debug.traceback)
if not ok then
    io.stdout:write("scriptgo verify: internal error: ", tostring(code), "\n")
    code = 2
end
io.stdout:flush()
os.exit(code)
