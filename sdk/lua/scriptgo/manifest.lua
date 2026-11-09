-- Resource manifest parser (scriptgo.lua / open77.lua). The manifest is parsed, never executed.
-- Mirrors packages/manifest (TypeScript): same grammar, same diagnostics, same fixtures.
local R = ...
local semver = R("semver")
local M = {}

M.CAPABILITIES = { "events", "logging", "storage", "players", "permissions", "commands", "config", "ui", "http", "licensing" }
M.KNOWN_ENVIRONMENTS = { "standalone", "love2d", "godot", "luanti", "open77", "openresty", "defold", "neovim" }
M.LUA_DIALECTS = { "5.1", "5.2", "5.3", "5.4", "luajit" }
M.CATEGORIES = { "inventory", "permissions", "economy", "events", "ui", "admin", "framework", "vehicles", "housing", "quests", "library", "other" }
M.MAX_MANIFEST_BYTES = 256 * 1024

local function set(list)
    local s = {}
    for _, v in ipairs(list) do s[v] = true end
    return s
end
local CAPS, ENVS, DIALECTS, CATS = set(M.CAPABILITIES), set(M.KNOWN_ENVIRONMENTS), set(M.LUA_DIALECTS), set(M.CATEGORIES)

-- OPEN//77 rule: 3 to 64 lowercase letters, digits or underscores, starting with a letter.
function M.isResourceName(s)
    return type(s) == "string" and #s >= 3 and #s <= 64 and s:match("^[a-z][a-z0-9_]*$") ~= nil
end

-- Environment ids and declarative export names: ^[a-z0-9][a-z0-9_-]{0,63}$.
function M.isSlug(s)
    return type(s) == "string" and #s <= 64 and s:match("^[a-z0-9][a-z0-9_%-]*$") ~= nil
end

-- Lexer ---------------------------------------------------------------------------------------
local SyntaxError = {}
local function syntax(code, message, line)
    error(setmetatable({ code = code, message = message, line = line }, SyntaxError), 0)
end

local ESC = { n = "\n", t = "\t", r = "\r", a = "\a", b = "\b", f = "\f", v = "\v", ["\\"] = "\\", ['"'] = '"', ["'"] = "'", ["\n"] = "\n" }

local function tokenize(src)
    local tokens, i, line, n = {}, 1, 1, #src
    local function push(kind, value, ln) tokens[#tokens + 1] = { kind = kind, value = value, line = ln or line } end
    local function longLevel(pos)
        if src:sub(pos, pos) ~= "[" then return -1 end
        local eq = src:match("^%[(=*)%[", pos)
        return eq and #eq or -1
    end
    local function readLong(level, startLine)
        i = i + level + 2
        if src:sub(i, i) == "\r" then i = i + 1 end
        if src:sub(i, i) == "\n" then i = i + 1; line = line + 1 end
        local close = "]" .. string.rep("=", level) .. "]"
        local s, e = src:find(close, i, true)
        if not s then syntax("unterminated_long_string", "Unterminated long string or comment.", startLine) end
        local text = src:sub(i, s - 1)
        for _ in text:gmatch("\n") do line = line + 1 end
        i = e + 1
        return text
    end
    while i <= n do
        local c = src:sub(i, i)
        if c == "\n" then
            line = line + 1; i = i + 1
        elseif c == " " or c == "\t" or c == "\r" or c == "\f" or c == "\v" then
            i = i + 1
        elseif c == "-" and src:sub(i + 1, i + 1) == "-" then
            i = i + 2
            local level = longLevel(i)
            if level >= 0 then readLong(level, line)
            else
                local e = src:find("\n", i, true)
                i = e or (n + 1)
            end
        elseif c:match("[%a_]") then
            local word = src:match("^[%w_]+", i)
            i = i + #word
            if word == "true" or word == "false" then push("boolean", word == "true")
            elseif word == "nil" then push("nil", nil)
            else push("ident", word) end
        elseif c:match("%d") or (c == "." and src:sub(i + 1, i + 1):match("%d")) or (c == "-" and src:sub(i + 1, i + 1):match("%d")) then
            local text
            if src:sub(i, i + 1):lower() == "0x" then
                text = src:match("^0[xX]%x+", i)
                push("number", tonumber(text:sub(3), 16))
            else
                text = src:match("^%-?[%d%.]+[eE][%+%-]?%d+", i) or src:match("^%-?[%d%.]+", i)
                local v = tonumber(text)
                if not v then syntax("invalid_number", "Invalid number '" .. text .. "'.", line) end
                push("number", v)
            end
            i = i + #text
        elseif c == '"' or c == "'" then
            local quote, startLine, j, out = c, line, i + 1, {}
            while true do
                if j > n then syntax("unterminated_string", "Unterminated string.", startLine) end
                local ch = src:sub(j, j)
                if ch == quote then j = j + 1; break end
                if ch == "\n" then syntax("unterminated_string", "Unterminated string.", startLine) end
                if ch == "\\" then
                    local nx = src:sub(j + 1, j + 1)
                    if nx == "" then syntax("unterminated_string", "Unterminated string.", startLine) end
                    if ESC[nx] then
                        out[#out + 1] = ESC[nx]
                        if nx == "\n" then line = line + 1 end
                        j = j + 2
                    elseif nx:match("%d") then
                        local digits = src:match("^%d%d?%d?", j + 1)
                        out[#out + 1] = string.char(tonumber(digits) % 256)
                        j = j + 1 + #digits
                    elseif nx == "x" then
                        local hex = src:sub(j + 2, j + 3)
                        if not hex:match("^%x%x$") then syntax("invalid_escape", "Invalid \\x escape.", line) end
                        out[#out + 1] = string.char(tonumber(hex, 16))
                        j = j + 4
                    else
                        syntax("invalid_escape", "Invalid escape '\\" .. nx .. "'.", line)
                    end
                else
                    out[#out + 1] = ch
                    j = j + 1
                end
            end
            push("string", table.concat(out), startLine)
            i = j
        elseif c == "[" then
            local level = longLevel(i)
            if level >= 0 then
                local startLine = line
                push("string", readLong(level, startLine), startLine)
            else
                push("[", "["); i = i + 1
            end
        elseif c:match("[{}%(%),;=%]]") then
            push(c, c); i = i + 1
        else
            syntax("unexpected_character", "Unexpected character '" .. c .. "'.", line)
        end
    end
    push("eof", nil)
    return tokens
end

-- Parser --------------------------------------------------------------------------------------
local function describe(t)
    if t.kind == "eof" then return "end of file" end
    if t.kind == "string" then return 'string "' .. tostring(t.value):sub(1, 32) .. '"' end
    return "'" .. tostring(t.value) .. "'"
end

local function parseDirectives(src)
    local tokens, pos = tokenize(src), 1
    local function peek(o) return tokens[pos + (o or 0)] end
    local function nextTok() local t = tokens[pos]; pos = pos + 1; return t end
    local function expect(kind, what)
        local t = nextTok()
        if t.kind ~= kind then syntax("unexpected_token", "Expected " .. what .. ", found " .. describe(t) .. ".", t.line) end
        return t
    end
    local parseTable
    local function parseValue()
        local t = nextTok()
        if t.kind == "string" or t.kind == "number" or t.kind == "boolean" then return t.value end
        if t.kind == "nil" then return nil end
        if t.kind == "{" then pos = pos - 1; return parseTable() end
        syntax("unexpected_token", "Expected a value, found " .. describe(t) .. ".", t.line)
    end
    function parseTable()
        local open = expect("{", "'{'")
        local tbl = { kind = "table", list = {}, map = {}, order = {} }
        while true do
            local t = peek()
            if t.kind == "}" then nextTok(); return tbl end
            if t.kind == "eof" then syntax("unterminated_table", "Unterminated table.", open.line) end
            if t.kind == "ident" and peek(1).kind == "=" then
                nextTok(); nextTok()
                tbl.map[t.value] = parseValue(); tbl.order[#tbl.order + 1] = t.value
            elseif t.kind == "[" then
                nextTok()
                local key = expect("string", "a string key")
                expect("]", "']'"); expect("=", "'='")
                tbl.map[key.value] = parseValue(); tbl.order[#tbl.order + 1] = key.value
            else
                tbl.list[#tbl.list + 1] = parseValue()
            end
            local sep = peek()
            if sep.kind == "," or sep.kind == ";" then nextTok()
            elseif sep.kind ~= "}" then
                syntax("unexpected_token", "Expected ',' or '}', found " .. describe(sep) .. ".", sep.line)
            end
        end
    end
    local function isArgStart(t)
        return t.kind == "string" or t.kind == "number" or t.kind == "boolean" or t.kind == "{" or t.kind == "("
    end
    local directives = {}
    while true do
        local t = peek()
        if t.kind == "eof" then break end
        if t.kind == ";" then nextTok()
        else
            if t.kind ~= "ident" then syntax("unexpected_token", "Expected a directive name, found " .. describe(t) .. ".", t.line) end
            nextTok()
            local d = { name = t.value, args = {}, line = t.line }
            if not isArgStart(peek()) then syntax("missing_argument", "Directive '" .. d.name .. "' needs a value.", t.line) end
            while isArgStart(peek()) do
                if peek().kind == "(" then
                    nextTok()
                    if peek().kind ~= ")" then
                        d.args[#d.args + 1] = parseValue()
                        while peek().kind == "," do nextTok(); d.args[#d.args + 1] = parseValue() end
                    end
                    expect(")", "')'")
                else
                    d.args[#d.args + 1] = parseValue()
                end
            end
            directives[#directives + 1] = d
        end
    end
    return directives
end
M.parseDirectives = parseDirectives

-- Interpretation ------------------------------------------------------------------------------
local DIRECTIVES = {}
local function def(names, key, kind) for _, n in ipairs(names) do DIRECTIVES[n] = { key = key, kind = kind } end end
for _, k in ipairs({ "resource", "version", "title", "description", "author", "license", "repository", "category", "scriptgo_version", "open77_version", "web_ui_page" }) do
    def({ k }, k, "string")
end
def({ "auto_start" }, "auto_start", "boolean")
def({ "licensed" }, "licensed", "boolean")
def({ "shared_script", "shared_scripts" }, "shared_scripts", "list")
def({ "server_script", "server_scripts" }, "server_scripts", "list")
def({ "client_script", "client_scripts" }, "client_scripts", "list")
def({ "test_script", "test_scripts" }, "test_scripts", "list")
def({ "file", "files" }, "files", "list")
def({ "web_file", "web_files" }, "web_files", "list")
def({ "permission", "permissions" }, "permissions", "list")
def({ "dependency", "dependencies" }, "dependencies", "list")
def({ "export", "exports" }, "exports", "list")
def({ "server_export", "server_exports" }, "server_exports", "list")
def({ "lua" }, "lua", "list")
def({ "environments" }, "environments", "list")
def({ "capability", "capabilities" }, "capabilities", "list")
def({ "optional_capability", "optional_capabilities" }, "optional_capabilities", "list")
def({ "environment_script", "environment_scripts" }, "environment_scripts", "envlist")

local function toPlain(v)
    if type(v) == "table" and v.kind == "table" then
        if #v.order == 0 then
            local out = {}
            for i, x in ipairs(v.list) do out[i] = toPlain(x) end
            return out
        end
        local out = {}
        for _, k in ipairs(v.order) do out[k] = toPlain(v.map[k]) end
        return out
    end
    return v
end

-- Globs with OPEN//77 semantics (same as packages/manifest globToRegExp): `*` and `?` stay in one
-- segment; `**/` needs at least one intermediate directory; a trailing `**` matches anything.
local function globMatch(g, gi, p, pi)
    while gi <= #g do
        if g:sub(gi, gi + 2) == "**/" then
            -- One or more non-empty segments, then the rest.
            local j = pi
            while true do
                local slash = p:find("/", j, true)
                if not slash or slash == j then return false end
                if globMatch(g, gi + 3, p, slash + 1) then return true end
                j = slash + 1
            end
        elseif g:sub(gi, gi + 1) == "**" then
            for k = pi, #p + 1 do
                if globMatch(g, gi + 2, p, k) then return true end
            end
            return false
        end
        local c = g:sub(gi, gi)
        if c == "*" then
            local k = pi
            while true do
                if globMatch(g, gi + 1, p, k) then return true end
                if k > #p or p:sub(k, k) == "/" then return false end
                k = k + 1
            end
        elseif c == "?" then
            if pi > #p or p:sub(pi, pi) == "/" then return false end
        elseif c ~= p:sub(pi, pi) then
            return false
        end
        gi, pi = gi + 1, pi + 1
    end
    return pi > #p
end

function M.isGlob(pattern) return pattern:find("[%*%?]") ~= nil end

function M.globMatch(pattern, path) return globMatch(pattern, 1, path, 1) end

-- Expands a pattern against a list of relative paths; sorted, like expandGlob in TypeScript.
function M.expandGlob(pattern, paths)
    local out = {}
    if not M.isGlob(pattern) then
        for _, f in ipairs(paths) do if f == pattern then out[1] = f break end end
        return out
    end
    for _, f in ipairs(paths) do
        if globMatch(pattern, 1, f, 1) then out[#out + 1] = f end
    end
    table.sort(out)
    return out
end

function M.unsafePathReason(p)
    if p == "" then return "empty path" end
    if p:find("\\", 1, true) then return "use '/' as the path separator" end
    if p:sub(1, 1) == "/" then return "absolute path" end
    if p:match("^%a:") then return "drive path" end
    for seg in (p .. "/"):gmatch("([^/]*)/") do
        if seg == ".." then return "path escapes the resource" end
    end
    if p:find("\0", 1, true) then return "NUL byte" end
    return nil
end

local function flatten(args, d, errors)
    local out = {}
    local function bad(msg) errors[#errors + 1] = { code = "invalid_value", message = msg, line = d.line } end
    for _, a in ipairs(args) do
        if type(a) == "string" then out[#out + 1] = a
        elseif type(a) == "table" then
            if #a.order > 0 then bad("'" .. d.name .. "' takes a list of strings, not key = value pairs.") end
            for _, item in ipairs(a.list) do
                if type(item) == "string" then out[#out + 1] = item
                else bad("'" .. d.name .. "' entries must be strings.") end
            end
        else
            bad("'" .. d.name .. "' entries must be strings.")
        end
    end
    return out
end

-- Returns { ok = true, manifest = ..., warnings = {...} } or { ok = false, errors = {...}, warnings = {...} }.
function M.parse(source, fileName)
    local errors, warnings = {}, {}
    local function err(code, message, line) errors[#errors + 1] = { code = code, message = message, line = line } end
    local function warn(code, message, line) warnings[#warnings + 1] = { code = code, message = message, line = line } end
    local format = (fileName and fileName:match("open77%.lua$")) and "open77" or "scriptgo"

    if #source > M.MAX_MANIFEST_BYTES then
        return { ok = false, errors = { { code = "manifest_too_large", message = "The manifest exceeds 256 KiB." } }, warnings = warnings }
    end
    local okParse, directives = pcall(parseDirectives, source)
    if not okParse then
        if getmetatable(directives) == SyntaxError then
            return { ok = false, errors = { { code = directives.code, message = directives.message, line = directives.line } }, warnings = warnings }
        end
        error(directives, 0)
    end

    local scalars, lists, envScripts, envOrder, unknown = {}, {}, {}, {}, {}
    for _, d in ipairs(directives) do
        local spec = DIRECTIVES[d.name]
        if not spec then
            local args = {}
            for i, a in ipairs(d.args) do args[i] = toPlain(a) end
            unknown[#unknown + 1] = { directive = d.name, args = args, line = d.line }
            warn("unknown_directive", "Directive '" .. d.name .. "' is not used by SCRIPT//GO and is kept as is.", d.line)
        elseif spec.kind == "string" or spec.kind == "boolean" then
            local v = d.args[1]
            if #d.args ~= 1 then err("invalid_value", "'" .. d.name .. "' takes exactly one value.", d.line)
            elseif spec.kind == "string" and type(v) ~= "string" then err("invalid_value", "'" .. d.name .. "' must be a string.", d.line)
            elseif spec.kind == "boolean" and type(v) ~= "boolean" then err("invalid_value", "'" .. d.name .. "' must be true or false.", d.line)
            elseif scalars[spec.key] then
                err("duplicate_directive", "'" .. d.name .. "' is declared more than once (first on line " .. scalars[spec.key].line .. ").", d.line)
            else
                scalars[spec.key] = { value = v, line = d.line }
            end
        elseif spec.kind == "envlist" then
            local env = d.args[1]
            if type(env) ~= "string" or #d.args < 2 then
                err("invalid_value", "'" .. d.name .. "' needs an environment and at least one script.", d.line)
            else
                local rest = {}
                for i = 2, #d.args do rest[#rest + 1] = d.args[i] end
                if not envScripts[env] then envScripts[env] = {}; envOrder[#envOrder + 1] = env end
                for _, p in ipairs(flatten(rest, d, errors)) do table.insert(envScripts[env], p) end
            end
        else
            lists[spec.key] = lists[spec.key] or {}
            for _, p in ipairs(flatten(d.args, d, errors)) do table.insert(lists[spec.key], p) end
        end
    end

    local function str(k) local s = scalars[k]; return (s and type(s.value) == "string") and s.value or nil end
    local function bool(k, fb) local s = scalars[k]; if s and type(s.value) == "boolean" then return s.value end; return fb end
    local function list(k) return lists[k] or {} end
    local function lineOf(k) return scalars[k] and scalars[k].line end

    local name = str("resource")
    if not name then err("missing_directive", "Directive 'resource' is required.")
    elseif not M.isResourceName(name) then
        err("invalid_resource_name", "Resource name must be 3 to 64 lowercase letters, digits or '_', starting with a letter (the OPEN//77 rule).", lineOf("resource"))
    end
    local version = str("version")
    if not version then err("missing_directive", "Directive 'version' is required.")
    elseif not semver.isValid(version) then
        err("invalid_version", "Version '" .. version .. "' is not valid semantic versioning (e.g. 1.4.0).", lineOf("version"))
    end
    for _, k in ipairs({ "scriptgo_version", "open77_version" }) do
        local r = str(k)
        if r and not semver.isValidRange(r) then err("invalid_range", "'" .. k .. "' range '" .. r .. "' is not valid.", lineOf(k)) end
    end

    local function checkScript(p, where)
        if p:sub(1, 1) == "@" then
            err("cross_resource_include", "'" .. p .. "' in " .. where .. ": cross-resource includes are refused. Share code through dependencies and exports.")
            return
        end
        local reason = M.unsafePathReason(p)
        if reason then err("unsafe_path", "'" .. p .. "' in " .. where .. ": " .. reason .. ".")
        elseif not p:match("%.lua$") then err("script_not_lua", "'" .. p .. "' in " .. where .. ": script entries must be .lua files.") end
    end
    for _, k in ipairs({ "shared_scripts", "server_scripts", "client_scripts", "test_scripts" }) do
        for _, p in ipairs(list(k)) do checkScript(p, k) end
    end
    for _, env in ipairs(envOrder) do
        if not M.isSlug(env) then err("invalid_environment", "Environment '" .. env .. "' in environment_script is not a valid slug.") end
        for _, p in ipairs(envScripts[env]) do checkScript(p, 'environment_script "' .. env .. '"') end
    end
    for _, k in ipairs({ "files", "web_files" }) do
        for _, p in ipairs(list(k)) do
            local reason = M.unsafePathReason(p)
            if reason then err("unsafe_path", "'" .. p .. "' in " .. k .. ": " .. reason .. ".") end
        end
    end
    local webUiPage = str("web_ui_page")
    if webUiPage then
        local reason = M.unsafePathReason(webUiPage)
        if reason then err("unsafe_path", "'" .. webUiPage .. "' in web_ui_page: " .. reason .. ".", lineOf("web_ui_page")) end
    end

    -- Declarative exports name global functions, as in OPEN//77 (manifest_export_missing at start).
    for _, k in ipairs({ "exports", "server_exports" }) do
        for _, e in ipairs(list(k)) do
            if not M.isSlug(e) then err("invalid_export_name", "'" .. e .. "' in " .. k .. ": export names are ^[a-z0-9][a-z0-9_-]{0,63}$.") end
        end
    end

    local dependencies = {}
    for _, entry in ipairs(list("dependencies")) do
        local depName, rest = entry:match("^%s*([a-z0-9][a-z0-9_%-]*)%s*(.-)%s*$")
        if not depName or #depName > 64 then
            err("invalid_dependency", "Dependency '" .. entry .. "' must look like \"name\" or \"name >=1.0.0\".")
        elseif rest ~= "" and not semver.isValidRange(rest) then
            err("invalid_dependency", "Dependency '" .. entry .. "' has an invalid version range.")
        else
            dependencies[#dependencies + 1] = { name = depName, range = rest ~= "" and rest or nil }
        end
    end
    for _, d in ipairs(list("lua")) do
        if not DIALECTS[d] then err("invalid_lua_dialect", "Lua dialect '" .. d .. "' is unknown.") end
    end
    for _, e in ipairs(list("environments")) do
        if not M.isSlug(e) then err("invalid_environment", "Environment '" .. e .. "' is not a valid slug.")
        elseif not ENVS[e] then warn("unknown_environment", "Environment '" .. e .. "' is not a SCRIPT//GO environment yet; it will show as not tested.") end
    end
    local function capOk(c) return CAPS[c] or c:match("^x%-[a-z0-9%-]+$") ~= nil end
    for _, k in ipairs({ "capabilities", "optional_capabilities" }) do
        for _, c in ipairs(list(k)) do
            if not capOk(c) then err("unknown_capability", "Capability '" .. c .. "' is unknown.") end
        end
    end
    local category = str("category") or "other"
    if not CATS[category] then warn("unknown_category", "Category '" .. category .. "' is unknown and will be shown as 'other'.", lineOf("category")) end
    local license = str("license")
    if license then
        local okLicense = true
        local first = true
        for word in license:gmatch("%S+") do
            if first or not (word == "AND" or word == "OR" or word == "WITH") then
                if not word:match("^[%w%.%+%-]+$") then okLicense = false end
            end
            first = false
        end
        if not okLicense then warn("license_not_spdx", "License '" .. license .. "' does not look like an SPDX expression.", lineOf("license")) end
    end
    if format == "scriptgo" and not str("scriptgo_version") then
        warn("missing_scriptgo_version", "Declare scriptgo_version (e.g. \">=0.1.0\") so hosts can check compatibility.")
    end
    local hasCode = #list("shared_scripts") > 0 or #list("server_scripts") > 0 or #list("client_scripts") > 0 or #envOrder > 0
    if not hasCode and #list("files") == 0 then err("empty_resource", "The resource declares no scripts and no files.") end

    if #errors > 0 then return { ok = false, errors = errors, warnings = warnings } end
    return {
        ok = true,
        warnings = warnings,
        manifest = {
            format = format, name = name, version = version,
            title = str("title"), description = str("description"), author = str("author"),
            license = license, repository = str("repository"),
            category = CATS[category] and category or "other",
            scriptgoVersion = str("scriptgo_version"), open77Version = str("open77_version"),
            autoStart = bool("auto_start", true), licensed = bool("licensed", false),
            lua = list("lua"), environments = list("environments"),
            capabilities = list("capabilities"), optionalCapabilities = list("optional_capabilities"),
            sharedScripts = list("shared_scripts"), serverScripts = list("server_scripts"),
            clientScripts = list("client_scripts"), environmentScripts = envScripts,
            testScripts = list("test_scripts"), dependencies = dependencies,
            permissions = list("permissions"), files = list("files"),
            exports = list("exports"), serverExports = list("server_exports"),
            webUiPage = webUiPage, webFiles = list("web_files"), unknown = unknown,
        },
    }
end

return M
