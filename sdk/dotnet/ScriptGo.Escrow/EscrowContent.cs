// An opened escrow release: the clear files, the encrypted files (decrypted, held by a content
// store), the delivery watermark, and the lease that keeps it usable.
//
// The lease is the revocation mechanism. The key service's answer is valid until ExpiresAt; the
// content asks again before that. When the answer becomes a definitive no (revoked, expired,
// refunded, unbound) or the service cannot be reached, the resource keeps running until
// OfflineGraceUntil, then the content raises Revoked (the host stops the resource) and wipes the
// decrypted files.
//
// Honest ceiling: this stops a host that plays by the rules, and makes every other host do visible
// work. It does not stop the operator of the machine from keeping a copy made while the license was
// valid. Escrow is deterrence, traceability and revocation, not a guarantee of secrecy.
using System.Text;

namespace ScriptGo.Escrow;

/// <summary>Where a lease stands.</summary>
public enum EscrowLeaseState
{
    /// <summary>The last key answer is valid and has not expired.</summary>
    Active,
    /// <summary>Past <see cref="EscrowContent.ExpiresAt"/>, or the last renewal was refused or failed:
    /// the resource runs on offline grace until <see cref="EscrowContent.OfflineGraceUntil"/>.</summary>
    Grace,
    /// <summary>Grace ran out (or the content was disposed). The decrypted files are wiped.</summary>
    Revoked,
}

public sealed class EscrowRevokedEventArgs(string reason) : EventArgs
{
    /// <summary>For example <c>refused:revoked</c> or <c>offline_grace_exhausted:key_service_unreachable:http_503</c>.</summary>
    public string Reason { get; } = reason;
}

/// <summary>The outcome of one renewal attempt.</summary>
/// <param name="State">The lease state after the attempt.</param>
/// <param name="Reason">Null on a granted renewal; otherwise why it was not granted.</param>
public sealed record EscrowRenewal(EscrowLeaseState State, string? Reason, DateTimeOffset ExpiresAt, DateTimeOffset OfflineGraceUntil);

public sealed class EscrowRenewalOptions
{
    /// <summary>How long before <see cref="EscrowContent.ExpiresAt"/> to ask again. Default: a third of
    /// the lease, never less than 1 second nor more than 5 minutes.</summary>
    public TimeSpan? RenewBefore { get; init; }

    /// <summary>How often to retry while on grace. Default 30 seconds.</summary>
    public TimeSpan RetryInterval { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>Called after every attempt, on the renewal task (for the host's log). Never pass key
    /// material or file contents to a log; this record holds none.</summary>
    public Action<EscrowRenewal>? OnRenewal { get; init; }
}

public sealed class EscrowContent : IDisposable
{
    private readonly IContentStore _store;
    private readonly EscrowBundle _bundle;
    private readonly EscrowIdentity _identity;
    private readonly IEscrowKeyService _keyService;
    private readonly EscrowOpenOptions _options;
    private readonly TimeProvider _time;
    private readonly object _gate = new();
    private readonly SemaphoreSlim _renewing = new(1, 1);
    private readonly HashSet<string> _encrypted;
    private DateTimeOffset _leaseStart, _expiresAt, _graceUntil;
    private string? _pendingReason, _revocationReason;
    private bool _revoked, _disposed;
    private long _managedCopies;
    private CancellationTokenSource? _renewalCancel;
    private Task? _renewalTask;

    internal EscrowContent(EscrowBundle bundle, IContentStore store, EscrowIdentity identity, IEscrowKeyService keyService,
        EscrowKeyResult grant, EscrowOpenOptions options)
    {
        _bundle = bundle;
        _store = store;
        _identity = identity;
        _keyService = keyService;
        _options = options;
        _time = options.TimeProvider;
        _encrypted = new HashSet<string>(store.Entries.Select(e => e.Path), StringComparer.Ordinal);
        Backend = identity.Backend;
        DeliveryWatermark = grant.DeliveryWatermark;
        if (grant.DeliveryWatermark is not null) store.SetMarker(Encoding.UTF8.GetBytes(grant.DeliveryWatermark + "\n"));
        ApplyGrant(grant);
    }

    /// <summary>The signed manifest (<c>escrow.json</c>).</summary>
    public EscrowManifest Manifest => _bundle.Manifest;

    /// <summary>Which backend holds the plaintext. <see cref="EscrowBackend.Managed"/> means every
    /// decrypted file is in managed memory, whatever method you use to read it.</summary>
    public EscrowBackend Backend { get; }

    /// <summary>The clear-text files of the release (manifest, docs, creator-named config), checked
    /// against the hashes in the signed manifest. Public data: ordinary managed arrays.</summary>
    public IReadOnlyDictionary<string, byte[]> ClearFiles => _bundle.ClearFiles;

    /// <summary>The files of the encrypted payload, in path order: path and size, never content.</summary>
    public IReadOnlyList<EscrowEntry> EncryptedEntries => _store.Entries;

    /// <summary>The per-delivery watermark the key service issued for this license and deployment, or
    /// null. It is also readable as the file <see cref="EscrowFormat.DeliveryMarker"/>. It attributes a
    /// later leak; it prevents nothing.</summary>
    public string? DeliveryWatermark { get; }

    /// <summary>True when the OS agreed to lock the plaintext in RAM (native backend, best effort).</summary>
    public bool MemoryLocked => _store.MemoryLocked;

    /// <summary>When the current key answer stops being valid.</summary>
    public DateTimeOffset ExpiresAt { get { lock (_gate) return _expiresAt; } }

    /// <summary>The last instant the resource may run without a fresh valid answer.</summary>
    public DateTimeOffset OfflineGraceUntil { get { lock (_gate) return _graceUntil; } }

    public EscrowLeaseState State
    {
        get
        {
            lock (_gate)
            {
                if (_revoked || _disposed) return EscrowLeaseState.Revoked;
                return _pendingReason is not null || _time.GetUtcNow() >= _expiresAt ? EscrowLeaseState.Grace : EscrowLeaseState.Active;
            }
        }
    }

    /// <summary>Why the content was revoked, once it was.</summary>
    public string? RevocationReason { get { lock (_gate) return _revocationReason; } }

    /// <summary>How many times an encrypted file was copied into managed memory through
    /// <see cref="CopyTo"/> or <see cref="ReadAllBytes"/>. A host that loads Lua through
    /// <see cref="LoadLuaChunk"/> on the native backend keeps this at zero.</summary>
    public long ManagedCopies => Interlocked.Read(ref _managedCopies);

    /// <summary>The exception that ended the background renewal loop, if one did.</summary>
    public Exception? RenewalFault { get; private set; }

    /// <summary>
    /// Raised once, when the lease ends for good: stop the resource (close its VM) in the handler.
    /// The decrypted files are wiped as soon as the handlers return. It is raised on the thread that
    /// noticed (the renewal task, or a caller of <see cref="RenewAsync"/>, <see cref="LoadLuaChunk"/>
    /// or <see cref="CopyTo"/>), so a single-threaded host should only queue the stop here.
    /// </summary>
    public event EventHandler<EscrowRevokedEventArgs>? Revoked;

    /// <summary>True when <paramref name="path"/> is a file of the encrypted payload.</summary>
    public bool ContainsEncrypted(string path) => _encrypted.Contains(path);

    /// <summary>The size of an encrypted file (or of the delivery marker), without reading it.</summary>
    public bool TryGetSize(string path, out long size)
    {
        if (!TryEnsureUsable()) { size = 0; return false; }
        try { return _store.TryGetSize(path, out size); }
        catch (ObjectDisposedException) { size = 0; return false; }
    }

    /// <summary>
    /// Compiles an encrypted Lua file into <paramref name="luaState"/> and leaves the function on the
    /// Lua stack, ready for <c>lua_pcall</c>. On the native backend the source goes from libscriptgo's
    /// guarded memory straight into the VM: it is never a managed string or byte array. The chunk is
    /// loaded in text mode only, so precompiled bytecode inside a release is refused by Lua.
    /// </summary>
    /// <param name="luaState">The <c>lua_State*</c> to load into (KeraLua: <c>lua.Handle</c>).</param>
    /// <param name="path">The resource-relative path of the file, for example <c>server/main.lua</c>.</param>
    /// <param name="chunkName">Lua's chunk name, shown in error messages (<c>@resource/server/main.lua</c>).</param>
    /// <param name="loader">The host's <c>luaL_loadbufferx</c>; see <see cref="LuaChunkLoader"/>.</param>
    /// <returns><see cref="LuaChunkStatus.Loaded"/> (function on the stack), <see cref="LuaChunkStatus.LuaError"/>
    /// (Lua's message on the stack) or <see cref="LuaChunkStatus.NotFound"/> (nothing pushed).</returns>
    /// <exception cref="EscrowException">The content was revoked.</exception>
    public LuaChunkResult LoadLuaChunk(IntPtr luaState, string path, string chunkName, LuaChunkLoader loader)
    {
        if (luaState == IntPtr.Zero) throw new ArgumentException("A null lua_State.", nameof(luaState));
        if (!loader.IsValid) throw new ArgumentException("An unresolved LuaChunkLoader.", nameof(loader));
        ArgumentNullException.ThrowIfNull(path);
        ArgumentNullException.ThrowIfNull(chunkName);
        EnsureUsable();
        if (!_encrypted.Contains(path)) return new LuaChunkResult(LuaChunkStatus.NotFound, 0);
        try { return _store.LoadLua(luaState, path, chunkName, loader.FunctionPointer); }
        catch (ObjectDisposedException) { throw RevokedError(); }
    }

    /// <summary>
    /// Copies a decrypted file into <paramref name="destination"/> and returns its length.
    /// THIS IS THE WEAKER DOOR: the plaintext enters managed memory, where this package can neither
    /// wipe it reliably nor keep it out of a heap dump. Use it where there is no other way: a script
    /// engine that takes managed source (JavaScript on Jint), or a data file the resource reads.
    /// For Lua, use <see cref="LoadLuaChunk"/>.
    /// </summary>
    /// <exception cref="FileNotFoundException">No such encrypted file.</exception>
    public int CopyTo(string path, Span<byte> destination)
    {
        EnsureUsable();
        try
        {
            if (!_store.TryCopy(path, destination, out var written)) throw new FileNotFoundException("No such file in the escrow payload.", path);
            if (_encrypted.Contains(path)) Interlocked.Increment(ref _managedCopies);
            return written;
        }
        catch (ObjectDisposedException) { throw RevokedError(); }
    }

    /// <summary>A decrypted file as a new managed array. The weaker door: see <see cref="CopyTo"/>.</summary>
    public byte[] ReadAllBytes(string path)
    {
        EnsureUsable();
        try
        {
            if (!_store.TryGetSize(path, out var size)) throw new FileNotFoundException("No such file in the escrow payload.", path);
            var buffer = new byte[size];
            CopyTo(path, buffer);
            return buffer;
        }
        catch (ObjectDisposedException) { throw RevokedError(); }
    }

    // ---------------------------------------------------------------------------------------- lease

    private void ApplyGrant(EscrowKeyResult grant)
    {
        var now = _time.GetUtcNow();
        var expires = grant.ExpiresAt ?? now + _options.DefaultLease;
        var grace = grant.OfflineGraceUntil ?? expires + _options.DefaultOfflineGrace;
        lock (_gate)
        {
            _leaseStart = now;
            _expiresAt = expires;
            _graceUntil = grace > expires ? grace : expires;
            _pendingReason = null;
        }
    }

    /// <summary>
    /// Asks the key service again, now. Granted: the lease is extended. Refused or unreachable: the
    /// lease is not extended and the resource runs on grace; once <see cref="OfflineGraceUntil"/> has
    /// passed the content is revoked (handlers run, then the decrypted files are wiped).
    /// Call it yourself on your own schedule, or let <see cref="StartRenewal"/> do it.
    /// </summary>
    public async Task<EscrowRenewal> RenewAsync(CancellationToken cancellation = default)
    {
        await _renewing.WaitAsync(cancellation).ConfigureAwait(false);
        try
        {
            if (State == EscrowLeaseState.Revoked) return Snapshot();

            EscrowKeyResult answer;
            try { answer = await _keyService.RequestKeyAsync(Manifest, _identity, cancellation).ConfigureAwait(false); }
            catch (HttpRequestException e) { answer = EscrowKeyResult.Unreachable("network:" + e.Message); }
            catch (TaskCanceledException e) when (!cancellation.IsCancellationRequested) { answer = EscrowKeyResult.Unreachable("timeout:" + e.Message); }

            if (answer.Valid && answer.WrappedKey is not null)
            {
                ApplyGrant(answer);
                return Snapshot();
            }

            // Not granted. A definitive refusal and an unreachable service both leave the resource
            // running on what is left of the offline grace; they differ in what we tell the host.
            var reason = answer.TransportError
                ? "key_service_unreachable:" + (answer.Reason ?? "no_answer")
                : "refused:" + (answer.Reason ?? "no_key");
            bool exhausted;
            lock (_gate)
            {
                _pendingReason = reason;
                exhausted = _time.GetUtcNow() >= _graceUntil;
            }
            if (exhausted) Revoke(answer.TransportError ? "offline_grace_exhausted:" + reason : reason);
            return Snapshot();
        }
        finally { _renewing.Release(); }
    }

    /// <summary>
    /// Starts a background task that renews before <see cref="ExpiresAt"/>, retries while on grace,
    /// and revokes at the end of grace. It stops on <see cref="StopRenewal"/>, on Dispose and after a
    /// revocation. Subscribe to <see cref="Revoked"/> first.
    /// </summary>
    public void StartRenewal(EscrowRenewalOptions? options = null)
    {
        options ??= new EscrowRenewalOptions();
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_renewalTask is not null) throw new InvalidOperationException("Renewal is already running.");
            _renewalCancel = new CancellationTokenSource();
            var token = _renewalCancel.Token;
            _renewalTask = Task.Run(() => RenewalLoop(options, token), token);
        }
    }

    /// <summary>Stops the background renewal task. The lease then only moves when you call <see cref="RenewAsync"/>.</summary>
    public void StopRenewal()
    {
        CancellationTokenSource? cancel;
        lock (_gate)
        {
            cancel = _renewalCancel;
            _renewalCancel = null;
            _renewalTask = null;
        }
        cancel?.Cancel();
        cancel?.Dispose();
    }

    private async Task RenewalLoop(EscrowRenewalOptions options, CancellationToken cancellation)
    {
        try
        {
            while (!cancellation.IsCancellationRequested)
            {
                var now = _time.GetUtcNow();
                DateTimeOffset due;
                lock (_gate)
                {
                    if (_revoked || _disposed) return;
                    if (_pendingReason is null)
                    {
                        var lease = _expiresAt - _leaseStart;
                        var margin = options.RenewBefore ?? Clamp(lease / 3, TimeSpan.FromSeconds(1), TimeSpan.FromMinutes(5));
                        due = _expiresAt - margin;
                        if (due <= _leaseStart) due = _leaseStart + lease / 2; // a lease shorter than the margin
                    }
                    else due = now + options.RetryInterval;
                    // Never ask more than once a second, whatever the answers say (a wrong clock on
                    // either side must not turn this loop into a flood), and never sleep past the
                    // end of grace: that is when the content must be revoked.
                    var earliest = now + MinimumInterval;
                    if (due < earliest) due = earliest;
                    if (due > _graceUntil) due = _graceUntil > earliest ? _graceUntil : earliest;
                }
                var delay = due - now;
                if (delay > TimeSpan.Zero)
                    await Task.Delay(delay < TimeSpan.FromDays(1) ? delay : TimeSpan.FromDays(1), _time, cancellation).ConfigureAwait(false);
                if (_time.GetUtcNow() < due) continue; // woke early (a capped delay): compute again
                var outcome = await RenewAsync(cancellation).ConfigureAwait(false);
                options.OnRenewal?.Invoke(outcome);
                if (outcome.State == EscrowLeaseState.Revoked) return;
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception e) { RenewalFault = e; }
    }

    private static readonly TimeSpan MinimumInterval = TimeSpan.FromSeconds(1);

    private static TimeSpan Clamp(TimeSpan value, TimeSpan min, TimeSpan max) => value < min ? min : value > max ? max : value;

    private EscrowRenewal Snapshot()
    {
        var state = State;
        lock (_gate) return new EscrowRenewal(state, _revoked ? _revocationReason : _pendingReason, _expiresAt, _graceUntil);
    }

    /// <summary>Ends the lease for good: handlers first (the host stops the resource), then the wipe,
    /// whatever the handlers did.</summary>
    private void Revoke(string reason)
    {
        lock (_gate)
        {
            if (_revoked || _disposed) return;
            _revoked = true;
            _revocationReason = reason;
        }
        try { Revoked?.Invoke(this, new EscrowRevokedEventArgs(reason)); }
        finally { _store.Dispose(); }
    }

    /// <summary>The lease also ends by the clock alone: a host that never renews cannot keep loading
    /// files past the end of grace.</summary>
    private bool TryEnsureUsable()
    {
        bool expired;
        lock (_gate)
        {
            if (_revoked || _disposed) return false;
            expired = _time.GetUtcNow() >= _graceUntil;
        }
        if (!expired) return true;
        string reason;
        lock (_gate) reason = _pendingReason ?? "not_renewed";
        Revoke("offline_grace_exhausted:" + reason);
        return false;
    }

    private void EnsureUsable()
    {
        if (!TryEnsureUsable()) throw RevokedError();
    }

    private EscrowException RevokedError()
    {
        lock (_gate)
        {
            return _disposed && !_revoked
                ? new EscrowException(EscrowFailure.Revoked, "revoked:disposed")
                : new EscrowException(EscrowFailure.Revoked, "revoked:" + (_revocationReason ?? "unknown"));
        }
    }

    /// <summary>Stops renewal and wipes the decrypted files. Does not raise <see cref="Revoked"/>.</summary>
    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
        }
        StopRenewal();
        _store.Dispose();
    }
}
