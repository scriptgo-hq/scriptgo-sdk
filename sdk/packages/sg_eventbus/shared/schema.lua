-- Small value schemas, shared by server and client. Defines the global `SgSchema`.
--
--   { type = "string", maxLength = 64, pattern = "^%w+$", enum = { "a", "b" }, optional = true }
--   { type = "number", min = 0, max = 100, integer = true }
--   { type = "boolean" }
--   { type = "table", fields = { name = <schema>, ... }, additional = false }
--   { type = "array", items = <schema>, maxItems = 50 }
--   { type = "any" }
SgSchema = {}

local function isInteger(n)
    return type(n) == "number" and n == math.floor(n) and n > -2 ^ 53 and n < 2 ^ 53
end

local function isArray(t)
    local n = 0
    for k in pairs(t) do
        if type(k) ~= "number" or k < 1 or k ~= math.floor(k) then return false end
        n = n + 1
    end
    return n == #t
end

local function check(value, schema, path)
    if schema == nil or schema.type == "any" then return true end
    if value == nil then
        if schema.optional then return true end
        return false, path .. ": required"
    end
    local t = schema.type
    if t == "string" then
        if type(value) ~= "string" then return false, path .. ": expected string" end
        if schema.maxLength and #value > schema.maxLength then return false, path .. ": longer than " .. schema.maxLength end
        if schema.minLength and #value < schema.minLength then return false, path .. ": shorter than " .. schema.minLength end
        if schema.pattern and not value:find(schema.pattern) then return false, path .. ": does not match pattern" end
        if schema.enum then
            local found = false
            for _, v in ipairs(schema.enum) do if v == value then found = true end end
            if not found then return false, path .. ": not one of the allowed values" end
        end
    elseif t == "number" then
        if type(value) ~= "number" or value ~= value then return false, path .. ": expected number" end
        if schema.integer and not isInteger(value) then return false, path .. ": expected integer" end
        if schema.min and value < schema.min then return false, path .. ": below " .. schema.min end
        if schema.max and value > schema.max then return false, path .. ": above " .. schema.max end
    elseif t == "boolean" then
        if type(value) ~= "boolean" then return false, path .. ": expected boolean" end
    elseif t == "table" then
        if type(value) ~= "table" then return false, path .. ": expected table" end
        for name, sub in pairs(schema.fields or {}) do
            local ok, err = check(value[name], sub, path .. "." .. name)
            if not ok then return false, err end
        end
        if schema.additional == false then
            for k in pairs(value) do
                if not (schema.fields or {})[k] then return false, path .. "." .. tostring(k) .. ": not allowed" end
            end
        end
    elseif t == "array" then
        if type(value) ~= "table" or not isArray(value) then return false, path .. ": expected array" end
        if schema.maxItems and #value > schema.maxItems then return false, path .. ": more than " .. schema.maxItems .. " items" end
        for i, item in ipairs(value) do
            local ok, err = check(item, schema.items, path .. "[" .. i .. "]")
            if not ok then return false, err end
        end
    else
        return false, path .. ": unknown schema type " .. tostring(t)
    end
    return true
end

-- Returns true, or false and "path: reason".
function SgSchema.validate(value, schema)
    return check(value, schema, "payload")
end

-- Checks that a schema itself is well formed.
function SgSchema.isSchema(schema)
    if schema == nil then return true end
    if type(schema) ~= "table" then return false end
    local t = schema.type
    if t == "table" then
        for _, sub in pairs(schema.fields or {}) do if not SgSchema.isSchema(sub) then return false end end
        return true
    elseif t == "array" then
        return SgSchema.isSchema(schema.items)
    end
    return t == "string" or t == "number" or t == "boolean" or t == "any"
end

SgSchema.TOPIC_PATTERN = "^[a-z0-9_]+[a-z0-9_:%.%-]*$"

function SgSchema.isTopic(name)
    return type(name) == "string" and #name <= 96 and name:find(SgSchema.TOPIC_PATTERN) ~= nil
end
