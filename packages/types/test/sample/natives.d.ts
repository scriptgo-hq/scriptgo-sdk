// The shape ScriptGo.Host's NativeModule.ToTypeScript writes for an integrator's native module.
declare namespace ScriptGoNatives {
  /** Pets of the host game. */
  namespace pets {
    /** Side: server. */
    function count(owner: string): number;
    /** Side: both. Permission: pets.rename. */
    function rename(id: number, name: string): void;
  }
}
