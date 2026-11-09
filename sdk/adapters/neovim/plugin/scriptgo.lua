-- SCRIPT//GO for Neovim: registers :ScriptGo. Nothing is loaded until setup() or the command runs.
if vim.g.loaded_scriptgo then return end
vim.g.loaded_scriptgo = true

vim.api.nvim_create_user_command("ScriptGo", function(o)
    require("scriptgo_nvim").command(o.args)
end, {
    nargs = "*",
    desc = "SCRIPT//GO: status, log, add <dir>, start <name>, stop <name>, or a resource command",
    complete = function(lead)
        local verbs = { "status", "log", "add", "start", "stop" }
        return vim.tbl_filter(function(v) return v:find(lead, 1, true) == 1 end, verbs)
    end,
})
