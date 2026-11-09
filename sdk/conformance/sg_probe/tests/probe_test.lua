-- The probe on the standalone host: every check passes.
describe("sg_probe", function()
    test("every conformance check passes", function()
        local h = load({ with = { "sg_eventbus", "sg_permissions", "sg_inventory" } })
        h:tick(1000)
        local r = h:call("sg_probe", "results")
        expect(r.done).toBe(true)
        if r.fail > 0 then
            for _, line in ipairs(r.lines) do print(line) end
        end
        expect(r.fail).toBe(0)
        expect(r.pass >= 20).toBe(true)
    end)
end)
