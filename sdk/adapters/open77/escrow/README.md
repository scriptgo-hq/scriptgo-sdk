# SCRIPT//GO escrow on OPEN//77

How an OPEN//77 operator runs an **encrypted** (escrowed) SCRIPT//GO resource — by their choice, with
no change forced into OPEN//77's core. Read `PROPOSAL.md` first; the format is `docs/spec/escrow.md`.

- **Option A (recommended, no OPEN//77 change):** `runner/` is `scriptgo-open77-escrow`, a tool the
  operator runs. It fetches the escrow release, verifies the signature, gets the content key wrapped
  to this server's X25519 key, **decrypts in C#** (`ScriptGo.Host.Escrow`), and writes the resource
  into the OPEN//77 resources root as a normal `open77.lua` folder. OPEN//77 discovers it unchanged.
  Build: `dotnet build runner/ScriptGo.Open77.Escrow.Runner.csproj`.
- **Option B (optional, OPEN//77's own review):** `option-b.patch` is the exact minimal core change
  (one flag + one resource-provider hook) that keeps the plaintext in memory. **Not applied to base.**

Honest caveat: on OPEN//77 (a disk-reading host) Option A writes decrypted scripts to the operator's
own resources directory, so code secrecy there is license-only-grade; binding, revocation, signing
and traceability remain real. Option B is the only way to avoid the disk write on OPEN//77.

Proven on the SCRIPT//GO host (`ScriptGo.Host.Tests.EscrowTests`), including the Option A
materialize→disk→run hand-off. What remains: a run on a live OPEN//77 server binary (we must not
modify or build the shared `base` checkout) — the one command is at the end of `PROPOSAL.md`.
