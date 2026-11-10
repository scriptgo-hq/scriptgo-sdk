// The last valid key answer per release and server identity, in memory only.
//
// Why a host wants one: opening the same release again (a restart or a reload of the resource)
// should not need the network while the answer is still valid, and a start during an outage may
// run on the offline grace of the last valid answer (docs/spec/escrow.md, "The lease").
//
// What is kept is a WRAPPED key: it opens nothing without the server identity's private key, which
// lives in libscriptgo. It is never written to disk, so a cold start always needs the key service.
namespace ScriptGo.Escrow;

/// <summary>How a remembered key answer stands against the clock.</summary>
public enum EscrowKeyFreshness
{
    /// <summary>Nothing usable is remembered: ask the key service.</summary>
    None,
    /// <summary>The answer has not expired: it can be used without a request.</summary>
    Fresh,
    /// <summary>The answer has expired but its offline grace has not ended: usable only when the
    /// key service cannot be reached.</summary>
    Grace,
}

/// <summary>
/// Remembers valid key answers in memory, keyed by release (its associated data and payload hash)
/// and server identity. Thread-safe. Pair it with <see cref="EscrowSession.Open"/>.
/// </summary>
public sealed class EscrowKeyCache(TimeProvider? time = null)
{
    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private readonly Dictionary<string, EscrowKeyResult> _answers = new(StringComparer.Ordinal);

    private static string Key(EscrowManifest manifest, EscrowIdentity identity) =>
        $"{manifest.Aad}\n{manifest.Payload.Sha256}\n{identity.PublicKeyBase64Url}";

    private static DateTimeOffset Deadline(EscrowKeyResult answer)
    {
        var expires = answer.ExpiresAt ?? DateTimeOffset.MinValue;
        return answer.OfflineGraceUntil is { } grace && grace > expires ? grace : expires;
    }

    /// <summary>
    /// Records what the key service just answered for this release: a valid answer is remembered
    /// (replacing the previous one), a refusal forgets it, an unreachable service changes nothing.
    /// An answer without <c>expiresAt</c> is not remembered: nothing says how long it stands.
    /// </summary>
    public void Record(EscrowManifest manifest, EscrowIdentity identity, EscrowKeyResult answer)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        ArgumentNullException.ThrowIfNull(identity);
        ArgumentNullException.ThrowIfNull(answer);
        var key = Key(manifest, identity);
        lock (_answers)
        {
            if (answer.Valid && answer.WrappedKey is not null)
            {
                if (answer.ExpiresAt is not null) _answers[key] = answer;
            }
            else if (!answer.TransportError) _answers.Remove(key);
        }
    }

    /// <summary>The remembered answer for this release and identity, and how it stands now. An
    /// answer past its offline grace is dropped and reported as <see cref="EscrowKeyFreshness.None"/>.</summary>
    public EscrowKeyFreshness TryGet(EscrowManifest manifest, EscrowIdentity identity, out EscrowKeyResult? answer)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        ArgumentNullException.ThrowIfNull(identity);
        var now = _time.GetUtcNow();
        lock (_answers)
        {
            foreach (var stale in _answers.Where(pair => now >= Deadline(pair.Value)).Select(static pair => pair.Key).ToArray())
                _answers.Remove(stale);
            if (!_answers.TryGetValue(Key(manifest, identity), out answer)) return EscrowKeyFreshness.None;
            return now < answer.ExpiresAt ? EscrowKeyFreshness.Fresh : EscrowKeyFreshness.Grace;
        }
    }

    /// <summary>Forgets the answer for this release and identity (the licence was refused elsewhere).</summary>
    public void Forget(EscrowManifest manifest, EscrowIdentity identity)
    {
        lock (_answers) _answers.Remove(Key(manifest, identity));
    }

    /// <summary>Forgets everything.</summary>
    public void Clear()
    {
        lock (_answers) _answers.Clear();
    }

    /// <summary>A key service that asks <paramref name="inner"/> every time and records each answer
    /// here. It never answers from memory: whether a remembered answer may be used is the host's
    /// decision (<see cref="TryGet"/>), because a renewal must reach the real service.</summary>
    public IEscrowKeyService Recording(IEscrowKeyService inner)
    {
        ArgumentNullException.ThrowIfNull(inner);
        return new RecordingKeyService(this, inner);
    }

    private sealed class RecordingKeyService(EscrowKeyCache cache, IEscrowKeyService inner) : IEscrowKeyService
    {
        public async Task<EscrowKeyResult> RequestKeyAsync(EscrowManifest manifest, EscrowIdentity identity, CancellationToken cancellation = default)
        {
            var answer = await inner.RequestKeyAsync(manifest, identity, cancellation).ConfigureAwait(false);
            cache.Record(manifest, identity, answer);
            return answer;
        }
    }
}
