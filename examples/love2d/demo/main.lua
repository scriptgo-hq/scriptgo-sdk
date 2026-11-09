-- SCRIPT//GO demo: InventoryKit, EventBus Kit and PermissionsKit running inside a LÖVE game.
-- The server side and the local client (player 1) run in this process; the screen draws the
-- client's inventory mirror, and the keys go through the same paths a real game would use.
--
--   love examples/love2d/demo                    play
--   lovec examples/love2d/demo --scriptgo-verify <resourceDir> --search sdk/packages --report out.json
local scriptgoLove = require("scriptgo_love")
if scriptgoLove.verify(arg) then return end

local SDK = scriptgoLove.normalize(love.filesystem.getSource() .. "/../../../sdk")
local PLAYER = 1
local ITEMS = { "water", "bread", "bandage", "rope", "scrap", "coin", "toolbox" }

local function rgb(hex) return { tonumber(hex:sub(1, 2), 16) / 255, tonumber(hex:sub(3, 4), 16) / 255, tonumber(hex:sub(5, 6), 16) / 255 } end
local CREAM, INK, COBALT, YELLOW = rgb("F4EFE4"), rgb("111111"), rgb("1F3FD1"), rgb("FFD23F")

local sg
local fonts = {}
local view = { state = nil, roles = {}, refusal = nil, admin = false, poll = 0 }

function love.load()
    love.keyboard.setKeyRepeat(true)
    fonts.title = love.graphics.newFont(30)
    fonts.body = love.graphics.newFont(14)
    fonts.small = love.graphics.newFont(12)
    sg = scriptgoLove.new({
        resources = { "sg_inventory", "sg_eventbus", "sg_permissions" },
        search = { SDK .. "/packages" },
        player = { id = PLAYER, name = "Ada" },
        config = {
            resources = { sg_inventory = { slots = 12, maxWeight = 20 } },
        },
    })
end

local function refresh()
    view.state = sg:call("sg_inventory", "getState", "client") or view.state
    view.roles = sg:call("sg_permissions", "roles", "client") or {}
    view.refusal = sg:call("sg_inventory", "lastRefusal", "client")
    view.admin = false
    for _, r in ipairs(view.roles) do if r == "admin" then view.admin = true end end
end

function love.update(dt)
    sg:update(dt)
    view.poll = view.poll - dt
    if view.poll <= 0 then
        view.poll = 0.1
        refresh()
    end
end

function love.keypressed(key, scancode, isrepeat)
    if sg:keypressed(key, scancode, isrepeat) then return end
    if isrepeat then return end
    if key == "g" then
        -- The console may always give.
        sg:command(("giveitem %d %s %d"):format(PLAYER, ITEMS[love.math.random(#ITEMS)], love.math.random(1, 3)))
    elseif key == "t" then
        -- The same command typed by the player: PermissionsKit decides.
        sg:playerCommand(("/giveitem %d coin 5"):format(PLAYER))
    elseif key == "u" or key == "1" then
        sg:call("sg_inventory", "use", "client", 1)
    elseif key == "a" then
        sg:command(("perm %s %d admin"):format(view.admin and "revoke" or "grant", PLAYER))
    elseif key == "c" then
        sg:call("sg_inventory", "clear", "server", PLAYER)
    elseif key == "escape" then
        love.event.quit()
    end
    view.poll = 0
end

function love.textinput(text) sg:textinput(text) end

function love.quit() sg:shutdown() end

-- Drawing ------------------------------------------------------------------------------------------
local function setColor(c, a) love.graphics.setColor(c[1], c[2], c[3], a or 1) end

local function drawSlot(x, y, size, index, item)
    setColor(INK, item and 1 or 0.18)
    love.graphics.setLineWidth(item and 2 or 1)
    love.graphics.rectangle("line", x, y, size, size, 4, 4)
    if index == 1 then
        setColor(YELLOW)
        love.graphics.rectangle("fill", x, y - 6, 34, 6)
    end
    love.graphics.setFont(fonts.small)
    setColor(INK, 0.45)
    love.graphics.print(tostring(index), x + 7, y + 5)
    if not item then return end
    setColor(COBALT)
    love.graphics.circle("fill", x + size / 2, y + size / 2 - 6, 17)
    setColor(CREAM)
    love.graphics.setFont(fonts.body)
    love.graphics.printf(item.label:sub(1, 1):upper(), x, y + size / 2 - 15, size, "center")
    setColor(INK)
    love.graphics.setFont(fonts.small)
    love.graphics.printf(item.label, x + 4, y + size - 22, size - 8, "center")
    setColor(COBALT)
    love.graphics.printf("x" .. tostring(item.count), x, y + 5, size - 7, "right")
end

function love.draw()
    love.graphics.clear(CREAM[1], CREAM[2], CREAM[3])
    local state = view.state or { slots = 12, maxWeight = 20, weight = 0, items = {} }

    setColor(INK)
    love.graphics.setFont(fonts.title)
    love.graphics.print("SCRIPT//GO", 40, 30)
    love.graphics.setFont(fonts.body)
    setColor(INK, 0.65)
    love.graphics.print("InventoryKit, EventBus Kit and PermissionsKit, running inside LÖVE", 40, 70)

    -- Inventory grid: the client mirror the server pushes after every change.
    local bySlot = {}
    for _, it in ipairs(state.items or {}) do bySlot[it.slot] = it end
    local size, gap, cols = 88, 12, 4
    local slots = math.max(1, state.slots or 12)
    for i = 1, slots do
        local col, row = (i - 1) % cols, math.floor((i - 1) / cols)
        drawSlot(40 + col * (size + gap), 120 + row * (size + gap), size, i, bySlot[i])
    end

    -- Weight bar.
    local rows = math.ceil(slots / cols)
    local barY, barW = 120 + rows * (size + gap) + 8, cols * size + (cols - 1) * gap
    local ratio = (state.maxWeight or 0) > 0 and math.min(1, (state.weight or 0) / state.maxWeight) or 0
    setColor(INK, 0.12)
    love.graphics.rectangle("fill", 40, barY, barW, 10, 3, 3)
    setColor(ratio > 0.8 and YELLOW or COBALT)
    love.graphics.rectangle("fill", 40, barY, barW * ratio, 10, 3, 3)
    setColor(INK)
    love.graphics.setFont(fonts.small)
    love.graphics.print(("%.1f / %.1f kg"):format(state.weight or 0, state.maxWeight or 0), 40, barY + 16)

    -- Keys and session.
    local x, y = 470, 120
    love.graphics.setFont(fonts.body)
    setColor(INK)
    love.graphics.print("Keys", x, y)
    love.graphics.setFont(fonts.small)
    local keys = {
        { "G", "give an item (console)" }, { "T", "/giveitem as the player" }, { "U", "use slot 1" },
        { "A", view.admin and "revoke admin" or "grant admin" }, { "C", "clear" }, { "`", "console" },
    }
    for i, k in ipairs(keys) do
        local ky = y + 6 + i * 22
        setColor(COBALT)
        love.graphics.rectangle("fill", x, ky, 20, 18, 3, 3)
        setColor(CREAM)
        love.graphics.printf(k[1], x, ky + 2, 20, "center")
        setColor(INK, 0.8)
        love.graphics.print(k[2], x + 28, ky + 2)
    end
    y = y + 180
    love.graphics.setFont(fonts.body)
    setColor(INK)
    love.graphics.print("Session", x, y)
    love.graphics.setFont(fonts.small)
    setColor(INK, 0.8)
    love.graphics.print("player " .. PLAYER .. " · roles: " .. (#view.roles > 0 and table.concat(view.roles, ", ") or "—"), x, y + 28)
    if view.refusal then
        love.graphics.print("last refusal: " .. tostring(view.refusal.action) .. " " .. tostring(view.refusal.reason), x, y + 48)
    end
    for i, name in ipairs({ "sg_eventbus", "sg_inventory", "sg_permissions" }) do
        local s = sg.host:resourceState(name)
        setColor(s == "started" and COBALT or YELLOW)
        love.graphics.circle("fill", x + 5, y + 78 + i * 18, 4)
        setColor(INK, 0.8)
        love.graphics.print(name .. " " .. s, x + 16, y + 70 + i * 18)
    end

    love.graphics.setFont(fonts.body)
    sg:draw()
end
