-- The asset-only package on the standalone host: it loads and starts with no script, and its
-- assets are files of the resource there (bundled: no player downloads anything).
describe("sg_assets_probe", function()
    test("an asset-only package starts with no script", function()
        local h = load()
        expect(h.host:resourceState(RESOURCE)).toBe("started")
        local m = h.host:getResource(RESOURCE).manifest
        expect(#m.serverScripts + #m.sharedScripts + #m.clientScripts).toBe(0)
        expect(#m.environmentAssets.luanti).toBe(2)
        expect(#m.environmentAssets.garrysmod).toBe(2)
    end)
end)
