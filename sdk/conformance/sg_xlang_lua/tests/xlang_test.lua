-- The portable (Lua-only) host must refuse the pair honestly: the TypeScript half needs a JS guest
-- (TypeScript runs as JavaScript), so starting it fails with language_unavailable:js instead of
-- running half the probe.
describe("sg_xlang_lua", function()
    test("a Lua-only host refuses the TypeScript half by name", function()
        local h = load({ start = false })
        local ok, why = h:start("sg_xlang_lua")
        expect(ok).toBeFalsy()
        print("start refused: " .. tostring(why))
        expect(tostring(why)).toContain("dependency sg_xlang_ts failed: language_unavailable:")
    end)
end)
