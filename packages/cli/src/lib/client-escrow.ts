// Client code escrow on the creator's side (docs/spec/client-escrow.md).
//
// `scriptgo publish --client-escrow` marks a release's client scripts for escrow. The platform builds
// every buyer's copy from the release's SOURCE with the same compiler as this file (it never takes
// bytecode from a creator), so this command compiles the same scripts here to:
//   - refuse a script that does not compile before anything is uploaded;
//   - write the creator's line map (`scriptgo-client-escrow-lines/1`), which turns the synthetic
//     positions of a fully stripped chunk (`night-market@2.0.0/client/hud.lua:pos:12:`) back into source
//     lines (`scriptgo escrow lines`). The compiler is deterministic, so the map matches every copy.
// The map holds line numbers only, never source, and is never shipped to a player.
//
// Which scripts are covered and which releases qualify: @scriptgo/manifest `clientEscrowIssues`, the
// same verdict the platform gives at upload.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  clientLineMap,
  ClientEscrowError,
  compileClientScript,
  type ClientLineMap,
  type ClientStrip,
  type CompiledClientScript,
} from "@scriptgo/escrow";
import { clientEscrowIssues, clientEscrowScripts, type ClientEscrowIssue, type ParsedManifest } from "@scriptgo/manifest";

export { clientEscrowIssues as clientEscrowErrors, clientEscrowScripts };

export interface ClientEscrowBuild {
  scripts: string[];
  compiled: CompiledClientScript[];
  lines: ClientLineMap;
  errors: ClientEscrowIssue[];
}

/**
 * Compiles every escrowed client script of a resource folder the way the platform will, and returns
 * the creator's line map. `pkg` is the registry identifier (`creator//slug`): the chunk names carry
 * `slug@version`, so a line map built under another name would not match the platform's chunks.
 */
export function buildClientLineMap(root: string, m: ParsedManifest, files: string[], opts: { package: string; strip: ClientStrip }): ClientEscrowBuild {
  const errors = clientEscrowIssues(m, files);
  const scripts = clientEscrowScripts(m, files);
  const compiled: CompiledClientScript[] = [];
  if (errors.length === 0) {
    for (const path of scripts) {
      try {
        compiled.push(compileClientScript(readFileSync(join(root, path)), { package: opts.package, version: m.version, path, strip: opts.strip }));
      } catch (e) {
        if (!(e instanceof ClientEscrowError)) throw e;
        errors.push({ code: `client_escrow_${e.code}`, message: e.message });
      }
    }
  }
  return { scripts, compiled, lines: clientLineMap(opts.package, m.version, opts.strip, compiled), errors };
}

/** Reads a line map file written by `publish --client-escrow`. */
export function readClientLineMap(file: string): ClientLineMap {
  const map = JSON.parse(readFileSync(file, "utf8")) as ClientLineMap;
  if (map?.format !== "scriptgo-client-escrow-lines/1" || typeof map.chunks !== "object") throw new Error(`${file} is not a client escrow line map (scriptgo-client-escrow-lines/1)`);
  return map;
}
