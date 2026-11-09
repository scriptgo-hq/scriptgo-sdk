// The JavaScript guest prelude of the .NET kit. Evaluated once in each Jint engine (one engine per
// resource side), it defines the runtime API as globals and returns the entry points the host
// calls. Same names and semantics as the Lua guest (docs/spec/multi-language.md), with the
// JavaScript idioms: Wait returns a promise (`await Wait(100)`), asynchronous calls return
// promises, and where Lua answers `nil|false, reason`, JavaScript throws a ScriptGoError whose
// `code` is the reason. Everything that leaves the resource goes through the host bridge
// (sg.call), where the codec copies the values.
(function (sg, ctx) {
  'use strict';
  const call = sg.call;
  const G = globalThis;
  const RESOURCE = ctx.resource;
  const SIDE = ctx.side;
  const ENVIRONMENT = ctx.environment;
  const THREAD_LIMIT = ctx.threads;
  const capabilities = ctx.capabilities.slice();
  const capabilitySet = new Set(capabilities);
  const permissionSet = new Set(ctx.permissions);
  let now = ctx.now;
  let tickCount = 0;

  class ScriptGoError extends Error {
    constructor(code, message, detail) {
      super(message === undefined ? code : message);
      this.name = 'ScriptGoError';
      this.code = code;
      if (detail !== undefined) this.detail = detail;
    }
  }

  const unavailable = (cap) => 'capability_unavailable:' + cap + '@' + ENVIRONMENT;
  const reasonOf = (e) => (e instanceof Error ? e.message : String(e));
  const describe = (e) => {
    if (!(e instanceof Error)) return String(e);
    const head = e.name + ': ' + e.message;
    if (!e.stack) return head;
    const stack = String(e.stack);
    return stack.startsWith(head) ? stack : head + '\n' + stack;
  };
  const log = (level, message) => { call('log', level, String(message)); };
  const logError = (e) => log('error', describe(e));

  // Answers a bridge result's values, or throws its failure.
  function ok(r, label) {
    if (r[0]) return r;
    const code = r[1] === 'codec_error' && r[2] !== undefined ? r[2] : r[1];
    throw new ScriptGoError(code, label === undefined ? code : label + ' ' + code);
  }

  // Context of the code running now: `source` and the invoking resource are valid in the synchronous
  // part of a handler, a command or an export (read them before the first await).
  const DEFAULT_CONTEXT = Object.freeze({ inThread: true, source: undefined, invoking: undefined });
  let context = DEFAULT_CONTEXT;
  function enterContext(c) {
    const prev = context;
    context = c;
    G.source = c.source;
    return prev;
  }
  function leaveContext(prev) {
    context = prev;
    G.source = prev.source;
  }

  // Scheduler: timers fire on the guest's tick; Wait(0) is the next tick.
  let nextTimerId = 0;
  const timers = new Map();
  function schedule(ms, fn) {
    if (timers.size >= THREAD_LIMIT) throw new ScriptGoError('quota_exceeded:threads');
    const id = ++nextTimerId;
    const d = Number(ms);
    timers.set(id, { wake: now + Math.max(0, Number.isFinite(d) ? d : 0) / 1000, created: tickCount, fn });
    return id;
  }
  function runTask(fn, args, c) {
    let r;
    const prev = enterContext(c);
    try {
      r = fn(...args);
    } catch (e) {
      logError(e);
      return;
    } finally {
      leaveContext(prev);
    }
    if (r !== null && typeof r === 'object' && typeof r.then === 'function') r.then(undefined, logError);
  }
  function inherit() {
    return { inThread: true, source: context.source, invoking: undefined };
  }

  function CreateThread(fn) {
    if (typeof fn !== 'function') throw new TypeError('CreateThread(fn): fn must be a function');
    runTask(fn, [], inherit());
  }
  function Wait(ms) {
    return new Promise((resolve) => { schedule(ms, resolve); });
  }
  function SetTimeout(ms, fn) {
    if (typeof fn !== 'function') throw new TypeError('SetTimeout(ms, fn): fn must be a function');
    const c = inherit();
    return schedule(ms, () => runTask(fn, [], c));
  }
  function ClearTimeout(id) { timers.delete(id); }

  // Events
  const handlers = new Map();
  function addHandler(name, fn, net) {
    if (typeof name !== 'string' || typeof fn !== 'function') {
      throw new TypeError('AddEventHandler(name, fn): name must be a string and fn a function');
    }
    const id = ok(call('addHandler', name, net))[1];
    handlers.set(id, fn);
    return id;
  }
  function AddEventHandler(name, fn) { return addHandler(name, fn, false); }
  function RemoveEventHandler(id) {
    const r = call('removeHandler', id);
    handlers.delete(id);
    return r[0] === true && r[1] === true;
  }
  function TriggerEvent(name, ...args) {
    if (typeof name !== 'string' || name === '' || name.length > 128) throw new ScriptGoError('invalid_event_name');
    ok(call('trigger', name, ...args));
    return true;
  }
  function RegisterNetEvent(name, fn) {
    call('registerNet', name);
    if (fn !== undefined) return addHandler(name, fn, true);
    return undefined;
  }
  function TriggerServerEvent(name, ...args) { ok(call('triggerServer', name, ...args)); return true; }
  function TriggerClientEvent(name, target, ...args) {
    if (typeof target !== 'number') throw new ScriptGoError('invalid_target');
    ok(call('triggerClient', name, target, ...args));
    return true;
  }

  // Exports: exports(name, fn) registers; exports.other.name(...) calls synchronously and answers the
  // first value; ScriptGo.exports.invoke answers every value; ScriptGo.exports.call is asynchronous.
  // An export returns several values with ScriptGo.values(a, b, ...).
  const VALUES = Symbol('ScriptGo.values');
  function values(...items) { return Object.freeze({ [VALUES]: items }); }
  function valuesOf(r) {
    if (r === undefined) return [];
    if (r !== null && typeof r === 'object' && Object.prototype.hasOwnProperty.call(r, VALUES)) return r[VALUES];
    return [r];
  }
  let loading = false;
  const exportFns = new Map();
  function registerExport(name, fn) {
    if (typeof name !== 'string' || name === '' || name.length > 64) throw new ScriptGoError('invalid_export_name');
    if (typeof fn !== 'function') throw new ScriptGoError('export_function_required');
    ok(call('exportRegister', name));
    exportFns.set(name, fn);
    return true;
  }
  function invokeExport(target, name, args) {
    const label = 'export ' + target + ':' + name;
    if (loading && !context.inThread) throw new ScriptGoError('resource_preparing', label + ' resource_preparing');
    return ok(call('exportSync', target, name, ...args), label).slice(1);
  }
  const proxies = new Map();
  function proxyFor(target) {
    let p = proxies.get(target);
    if (p === undefined) {
      p = new Proxy({}, {
        get(_, name) {
          if (typeof name !== 'string') return undefined;
          return (...args) => invokeExport(target, name, args)[0];
        },
      });
      proxies.set(target, p);
    }
    return p;
  }
  const exportsProxy = new Proxy(function exports(name, fn) { return registerExport(name, fn); }, {
    get(_, prop) {
      if (typeof prop !== 'string') return undefined;
      return proxyFor(prop);
    },
    set() { throw new TypeError('exports is not assignable'); },
  });
  function GetInvokingResource() { return context.invoking; }

  let nextPromiseId = 0;
  const pending = new Map();
  function hostPromise(op, ...args) {
    const id = ++nextPromiseId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const r = call(op, id, ...args);
      if (!r[0]) {
        pending.delete(id);
        const code = r[1] === 'codec_error' && r[2] !== undefined ? r[2] : r[1];
        reject(new ScriptGoError(code));
      }
    });
  }

  // Commands
  const commands = new Map();
  function RegisterCommand(name, fn, restricted) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.:-]+$/.test(name) || typeof fn !== 'function') {
      throw new TypeError('RegisterCommand(name, fn, restricted?): invalid arguments');
    }
    ok(call('registerCommand', name, restricted === true));
    commands.set(name.toLowerCase(), fn);
    return true;
  }

  function GetCurrentResourceName() { return RESOURCE; }
  function GetResourceState(name) { return call('resourceState', name)[1]; }
  function GetConvar(name, fallback) {
    const r = call('convar', name);
    return r[0] && r[1] !== undefined ? r[1] : fallback;
  }

  // JSON with sorted keys, as the Lua core's (the same value always encodes to the same text).
  function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
      return out;
    }
    return v;
  }

  function capTable(cap, members) {
    return new Proxy(members, {
      get(t, k) {
        if (!capabilitySet.has(cap)) throw new ScriptGoError(unavailable(cap));
        return t[k];
      },
      set() { throw new TypeError('ScriptGo.' + cap + ' is read-only'); },
    });
  }

  const ScriptGo = {
    ScriptGoError,
    values,
    log: {
      debug: (m) => log('debug', m),
      info: (m) => log('info', m),
      warn: (m) => log('warn', m),
      error: (m) => log('error', m),
    },
    json: {
      encode: (v) => JSON.stringify(sortKeys(v)),
      decode: (s) => JSON.parse(s),
      null: null,
      object: (t) => t,
    },
    time: {
      monotonic: () => now,
      now: () => {
        const r = call('time');
        return r[0] && r[1] !== undefined ? r[1] : Math.floor(Date.now() / 1000);
      },
    },
    runtime: {
      version: () => ctx.runtimeVersion,
      environment: () => ENVIRONMENT,
      side: () => SIDE,
      adapterVersion: () => ctx.adapterVersion,
      language: () => 'js',
    },
    resource: {
      name: () => RESOURCE,
      version: () => ctx.version,
      generation: (other) => call('resourceGeneration', other)[1],
      state: (other) => call('resourceState', other === undefined ? RESOURCE : other)[1],
      hasPermission: (p) => permissionSet.has(p),
      readFile: (rel) => {
        if (typeof rel !== 'string') throw new ScriptGoError('invalid_path');
        return ok(call('resourceFile', rel))[1];
      },
      manifest: () => call('manifest')[1],
    },
    events: { on: AddEventHandler, off: RemoveEventHandler, emit: TriggerEvent },
    net: { on: RegisterNetEvent, register: RegisterNetEvent, emitServer: TriggerServerEvent, emitClient: TriggerClientEvent },
    exports: {
      call: (target, name, ...args) => {
        if (typeof target !== 'string' || typeof name !== 'string') return Promise.reject(new ScriptGoError('invalid_export_name'));
        return hostPromise('exportAsync', target, name, ...args);
      },
      invoke: (target, name, ...args) => invokeExport(target, name, args),
    },
    capabilities: {
      has: (c) => capabilitySet.has(c),
      list: () => capabilities.slice(),
      require: (c) => { if (!capabilitySet.has(c)) throw new ScriptGoError(unavailable(c)); },
    },
    storage: capTable('storage', {
      get: (key) => { const r = call('storageGet', String(key)); return r[0] ? r[1] : undefined; },
      set: (key, value) => { ok(call('storageSet', String(key), value)); return true; },
      delete: (key) => { call('storageDelete', String(key)); return true; },
      keys: (prefix) => { const r = call('storageKeys', prefix); return r[0] ? r[1] : []; },
    }),
    players: capTable('players', {
      list: () => { const r = call('playersList'); return r[0] ? r[1] : []; },
      name: (id) => call('playerName', id)[1],
      exists: (id) => call('playerName', id)[1] !== undefined,
      identifier: (id) => call('playerIdentifier', id)[1],
    }),
    permissions: capTable('permissions', {
      has: (playerId, privilege) => { const r = call('permissionsHas', playerId, privilege); return r[0] === true && r[1] === true; },
    }),
    ui: capTable('ui', {
      notify: (target, payload) => {
        // A client notifies its own player: notify(payload) or notify(undefined, payload).
        if (SIDE === 'client') {
          if (payload === undefined) payload = target;
          target = undefined;
        }
        if (payload === null || typeof payload !== 'object') throw new ScriptGoError('invalid_payload');
        ok(call('uiNotify', target === undefined ? -1 : target, payload));
        return true;
      },
    }),
    config: capTable('config', {
      get: (key, fallback) => {
        const r = call('configGet', key);
        return r[0] && r[1] !== undefined ? r[1] : fallback;
      },
    }),
    http: capTable('http', {
      request: (opts) => {
        if (SIDE !== 'server') return Promise.reject(new ScriptGoError('http is server-side only'));
        if (opts === null || typeof opts !== 'object') return Promise.reject(new ScriptGoError('invalid_request'));
        return hostPromise('http', opts).then((v) => v[0]);
      },
    }),
    licensing: capTable('licensing', {
      activate: (opts) => licensing('activate', opts),
      verify: (opts) => licensing('verify', opts),
    }),
    notifications: {
      send: (target, payload) => ScriptGo.ui.notify(target, payload),
      broadcast: (payload) => ScriptGo.ui.notify(-1, payload),
    },
    natives: {},
  };

  function licensing(kind, opts) {
    if (SIDE !== 'server') return Promise.reject(new ScriptGoError('licensing is server-side only'));
    if (!capabilitySet.has('http')) return Promise.reject(new ScriptGoError(unavailable('http')));
    if (opts === null || typeof opts !== 'object') return Promise.reject(new ScriptGoError('invalid_request'));
    return hostPromise('licensing', kind, opts).then((v) => {
      if (v[0] === undefined) throw new ScriptGoError(v[1], v[1], v[2]);
      return v[0];
    });
  }

  // Native modules the integrator registered: ScriptGo.natives.<module>.<fn>(...) answers the first
  // value (ScriptGo.natives.invoke answers all of them) and throws ScriptGoError on refusal.
  for (const moduleName of Object.keys(ctx.natives)) {
    const desc = ctx.natives[moduleName];
    const m = {};
    for (const fnName of desc.functions) {
      m[fnName] = (...args) => {
        const r = ok(call('native', moduleName, fnName, ...args), moduleName + '.' + fnName);
        return r.length > 1 ? r[1] : undefined;
      };
    }
    Object.freeze(m);
    ScriptGo.natives[moduleName] = m;
    if (desc.global) G[moduleName] = m;
  }
  Object.freeze(ScriptGo.natives);

  const consoleObject = {
    log: (...a) => log('info', a.map(String).join(' ')),
    info: (...a) => log('info', a.map(String).join(' ')),
    debug: (...a) => log('debug', a.map(String).join(' ')),
    warn: (...a) => log('warn', a.map(String).join(' ')),
    error: (...a) => log('error', a.map((x) => (x instanceof Error ? describe(x) : String(x))).join(' ')),
  };

  const api = {
    CreateThread, Wait, SetTimeout, ClearTimeout,
    AddEventHandler, RemoveEventHandler, TriggerEvent, RegisterNetEvent, TriggerServerEvent, TriggerClientEvent,
    exports: exportsProxy, GetInvokingResource, RegisterCommand, GetCurrentResourceName, GetResourceState, GetConvar,
    ScriptGo, ScriptGoError,
    print: (...a) => log('info', a.map(String).join('\t')),
    console: consoleObject,
    setTimeout: (fn, ms, ...args) => {
      if (typeof fn !== 'function') throw new TypeError('setTimeout(fn, ms): fn must be a function');
      const c = inherit();
      return schedule(ms, () => runTask(fn, args, c));
    },
    clearTimeout: ClearTimeout,
  };
  for (const name of Object.keys(api)) {
    Object.defineProperty(G, name, { value: api[name], writable: true, configurable: true, enumerable: false });
  }
  G.source = undefined;

  // Entry points the host calls. Each answers an array: [true, ...values] or [false, reason].
  return {
    loading(flag) {
      loading = flag === true;
      context = loading ? Object.freeze({ inThread: false, source: undefined, invoking: undefined }) : DEFAULT_CONTEXT;
      G.source = undefined;
      return [true];
    },
    recover() {
      context = DEFAULT_CONTEXT;
      loading = false;
      G.source = undefined;
      return [true];
    },
    publish(name) {
      const fn = G[name];
      if (typeof fn !== 'function') return [true, false];
      const r = call('exportRegister', name);
      if (r[0]) exportFns.set(name, fn);
      return [true, r[0] === true];
    },
    tick(n, tc) {
      now = n;
      tickCount = tc;
      const due = [];
      for (const [id, t] of timers) if (t.wake <= now && t.created < tickCount) due.push(id);
      due.sort((a, b) => a - b);
      for (const id of due) {
        const t = timers.get(id);
        if (t === undefined) continue;
        timers.delete(id);
        t.fn();
      }
      return [true];
    },
    settle(id, success, ...items) {
      const p = pending.get(id);
      if (p === undefined) return [true];
      pending.delete(id);
      if (success) p.resolve(items);
      else p.reject(new ScriptGoError(items[0] === undefined ? 'promise_rejected' : String(items[0])));
      return [true];
    },
    handler(id, source, invoking, ...args) {
      const fn = handlers.get(id);
      if (fn !== undefined) runTask(fn, args, { inThread: true, source, invoking });
      return [true];
    },
    // A synchronous export must finish without waiting: a returned promise is export_yielded.
    exportSync(name, invoking, ...args) {
      const fn = exportFns.get(name);
      if (fn === undefined) return [false, 'export_not_found'];
      let r;
      const prev = enterContext({ inThread: true, source: undefined, invoking });
      try {
        r = fn(...args);
      } catch (e) {
        return [false, reasonOf(e)];
      } finally {
        leaveContext(prev);
      }
      if (r !== null && typeof r === 'object' && typeof r.then === 'function') {
        r.then(undefined, () => {});
        return [false, 'export_yielded'];
      }
      return [true, ...valuesOf(r)];
    },
    exportAsync(callId, name, invoking, ...args) {
      const done = (success, items) => {
        const r = call('asyncDone', callId, success, ...items);
        if (!r[0]) call('asyncDone', callId, false, r[1]);
      };
      const fn = exportFns.get(name);
      if (fn === undefined) {
        done(false, ['export_not_found']);
        return [true];
      }
      let r;
      const prev = enterContext({ inThread: true, source: undefined, invoking });
      try {
        r = fn(...args);
      } catch (e) {
        done(false, ['export_failed: ' + reasonOf(e)]);
        return [true];
      } finally {
        leaveContext(prev);
      }
      Promise.resolve(r).then(
        (v) => done(true, valuesOf(v)),
        (e) => done(false, ['export_failed: ' + reasonOf(e)]),
      );
      return [true];
    },
    // Commands run on the next tick, as in the Lua core.
    command(name, source, raw, ...words) {
      const fn = commands.get(name);
      if (fn !== undefined) {
        const c = { inThread: true, source, invoking: undefined };
        schedule(0, () => runTask(fn, [source, words, raw], c));
      }
      return [true];
    },
  };
});
