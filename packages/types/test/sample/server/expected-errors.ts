// Misuse the declarations must reject: each @ts-expect-error fails the check if no error follows.
async function misuse(): Promise<void> {
  // @ts-expect-error Wait needs a duration.
  await Wait();
  // @ts-expect-error no such storage member.
  ScriptGo.storage.nope("k");
  // @ts-expect-error no such native function.
  ScriptGo.natives.pets.missing();
  // @ts-expect-error the internal brand of the natives namespace is hidden.
  void ScriptGo.natives.__modules;
  // @ts-expect-error natives.invoke needs the module and function names.
  ScriptGo.natives.invoke("pets");
  // @ts-expect-error command names are strings.
  RegisterCommand(1, () => undefined);
  // @ts-expect-error monotonic time is a number.
  const t: string = ScriptGo.time.monotonic();
  // @ts-expect-error http.request needs a url.
  await ScriptGo.http.request({ method: "GET" });
  // @ts-expect-error onResourceStart passes the resource name, a string.
  AddEventHandler("onResourceStart", (resource) => resource.toFixed());
  // @ts-expect-error the runtime has no Node globals.
  process.exit(1);
  // @ts-expect-error the runtime has no DOM.
  document.title = "x";
  void t;
}
void misuse;
