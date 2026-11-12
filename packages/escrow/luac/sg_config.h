/*
 * Forced include for the SCRIPT//GO publish-time Lua compiler (sg_luac.c), built to WebAssembly.
 *
 * WebAssembly has no setjmp/longjmp without the exception-handling proposal, so a Lua error does
 * not unwind: sg_throw records the message and traps. The module is instantiated once per compile,
 * so a trapped instance is simply dropped. Nothing else about Lua changes: the parser, the code
 * generator and the dump format are PUC Lua 5.4.8's own, so the bytecode is exactly what the target
 * VM (the client's statically linked Lua 5.4.8) loads.
 */
#ifndef SG_CONFIG_H
#define SG_CONFIG_H

struct lua_State;
__attribute__((noreturn)) void sg_throw(struct lua_State *L, int status);

#define LUAI_THROW(L, c) sg_throw(L, (c)->status)
#define LUAI_TRY(L, c, a) { a }
#define luai_jmpbuf int
/* No signals in WebAssembly; the hook flag needs only to be an int here (no hook is ever set). */
#define l_signalT int

/* A fixed string-hash seed: the bytecode does not depend on it, the build is just reproducible. */
#define luai_makeseed(L) 0u

#endif
