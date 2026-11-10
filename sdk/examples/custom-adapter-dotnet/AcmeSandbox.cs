// Acme Engine's own Lua sandbox: one KeraLua state per resource and a handful of host functions.
// Nothing here comes from SCRIPT//GO. It is deliberately tiny (no quotas, no scheduler): a real
// engine has its own, and the point of this example is the three places where escrow touches it.
//
//   (1) the entry script is compiled by EscrowContent.LoadLuaChunk straight into this state;
//   (2) `require` does the same for the resource's modules;
//   (3) nothing ever asks for the source as a string or a byte array.
using KeraLua;
using ScriptGo.Escrow;

namespace Acme.Engine;

internal sealed class AcmeSandbox : IDisposable
{
    // Acme's API for scripts, written in Lua on top of two host functions. Host functions never
    // raise a Lua error from C# (that would unwind through managed frames): they answer
    // `nil, message` and this prelude raises.
    private const string Prelude = """
        local host_log, host_chunk = __acme_log, __acme_chunk
        __acme_log, __acme_chunk = nil, nil

        -- What a server script must not reach.
        io, package, debug, dofile, loadfile, load = nil, nil, nil, nil, nil, nil
        os = { time = os.time, clock = os.clock, date = os.date }

        local function text(...)
            local parts = table.pack(...)
            for i = 1, parts.n do parts[i] = tostring(parts[i]) end
            return table.concat(parts, "\t")
        end
        function print(...) host_log("info", text(...)) end

        local handlers = {}
        acme = {
            log = function(level, message) host_log(tostring(level), tostring(message)) end,
            on = function(event, fn)
                assert(type(event) == "string" and type(fn) == "function", "acme.on(event, fn)")
                handlers[event] = handlers[event] or {}
                table.insert(handlers[event], fn)
            end,
            emit = function(event, ...)
                for _, fn in ipairs(handlers[event] or {}) do
                    local ok, err = pcall(fn, ...)
                    if not ok then host_log("error", event .. ": " .. tostring(err)) end
                end
            end,
        }

        -- require("a.b") runs a/b.lua of this resource, once. The host compiles it (from escrowed
        -- memory); this side only caches the result.
        local loaded = {}
        function require(name)
            if type(name) ~= "string" or not name:match("^[%w_%-]+[%w_%-%.]*$") or name:find("..", 1, true) then
                error("invalid module name", 2)
            end
            if loaded[name] ~= nil then return loaded[name] end
            local fn, err = host_chunk((name:gsub("%.", "/")) .. ".lua")
            if not fn then error("module '" .. name .. "': " .. tostring(err), 2) end
            local value = fn(name)
            if value == nil then value = true end
            loaded[name] = value
            return value
        end

        return acme.emit
        """;

    private readonly Lua _lua;
    private readonly EscrowContent _content;
    private readonly LuaChunkLoader _loader;
    private readonly string _resource;
    private readonly Action<string, string> _log;
    // Delegates handed to Lua must stay referenced for as long as the state lives.
    private readonly LuaFunction _logFunction, _chunkFunction;
    private readonly int _emitRef;
    private bool _disposed;

    public AcmeSandbox(string resource, EscrowContent content, LuaChunkLoader loader, Action<string, string> log)
    {
        _resource = resource;
        _content = content;
        _loader = loader;
        _log = log;
        _lua = new Lua();
        _logFunction = HostLog;
        _chunkFunction = HostChunk;
        _lua.PushCFunction(_logFunction);
        _lua.SetGlobal("__acme_log");
        _lua.PushCFunction(_chunkFunction);
        _lua.SetGlobal("__acme_chunk");
        if (_lua.LoadString(Prelude, "=acme/prelude") != LuaStatus.OK || _lua.PCall(0, 1, 0) != LuaStatus.OK)
            throw new InvalidOperationException("acme prelude: " + _lua.ToString(-1));
        _emitRef = _lua.Ref(LuaRegistry.Index);
    }

    /// <summary>Runs one script of the resource at file scope. (1) in the header comment.</summary>
    public (bool Ok, string? Error) RunScript(string path)
    {
        var chunk = _content.LoadLuaChunk(_lua.Handle, path, $"@{_resource}/{path}", _loader);
        if (chunk.Status == LuaChunkStatus.NotFound) return (false, $"{path}: not in the release");
        if (!chunk.Ok || _lua.PCall(0, 0, 0) != LuaStatus.OK)
        {
            var message = _lua.ToString(-1);
            _lua.SetTop(0);
            return (false, message);
        }
        return (true, null);
    }

    /// <summary>Raises an engine event in the resource (acme.on handlers).</summary>
    public void Emit(string name, params string[] arguments)
    {
        if (_disposed) return;
        _lua.RawGetInteger(LuaRegistry.Index, _emitRef);
        _lua.PushString(name);
        foreach (var argument in arguments) _lua.PushString(argument);
        if (_lua.PCall(1 + arguments.Length, 0, 0) != LuaStatus.OK)
        {
            _log("error", _lua.ToString(-1));
            _lua.SetTop(0);
        }
    }

    // __acme_log(level, message)
    private int HostLog(IntPtr state)
    {
        try
        {
            var lua = Lua.FromIntPtr(state);
            _log(lua.ToString(1) ?? "info", lua.ToString(2) ?? "");
        }
        catch (Exception) { /* never let a managed exception cross into Lua */ }
        return 0;
    }

    // __acme_chunk(path) answers the compiled function, or nil and a message. (2) in the header comment.
    private int HostChunk(IntPtr state)
    {
        var lua = Lua.FromIntPtr(state);
        try
        {
            var path = lua.ToString(1) ?? "";
            // `state` may be a coroutine of this resource: load into the state that asked.
            var chunk = _content.LoadLuaChunk(state, path, $"@{_resource}/{path}", _loader);
            switch (chunk.Status)
            {
                case LuaChunkStatus.Loaded:
                    return 1; // the function is on top of the stack
                case LuaChunkStatus.LuaError:
                    lua.PushNil(); // Lua's message is on top: answer nil, message
                    lua.Insert(-2);
                    return 2;
                default:
                    lua.PushNil();
                    lua.PushString("not found");
                    return 2;
            }
        }
        catch (Exception e) // for example EscrowException: the content was revoked
        {
            lua.PushNil();
            lua.PushString(e.Message);
            return 2;
        }
    }

    /// <summary>Closing the state is what releases the compiled code of the resource.</summary>
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _lua.Close();
        _lua.Dispose();
    }
}
