/*
 * SCRIPT//GO publish-time Lua compiler: PUC Lua 5.4.8's own parser and code generator, built to
 * WebAssembly, with a dumper that writes the standard 5.4 bytecode format under four strip modes.
 * docs/spec/client-escrow.md, "Bytecode compilation".
 *
 *   SG_STRIP_NONE   (0)  every debug field: byte for byte what luaU_dump(..., strip = 0) writes
 *   SG_STRIP_NAMES  (1)  source name and line info kept; local and upvalue names dropped
 *   SG_STRIP_FULL   (2)  no names and no line info. Each instruction carries an opaque POSITION
 *                        instead of a line (main's first instruction is 1, then every instruction
 *                        of the chunk in dump order), so a runtime error names a position the
 *                        creator's line map resolves, and nothing about the source. The main
 *                        function's source is `dumpSource` (the chunk name, never a disk path).
 *   SG_STRIP_STOCK  (3)  byte for byte what luaU_dump(..., strip = 1) writes (tests compare it with
 *                        string.dump(f, true) of a native Lua 5.4.8)
 *
 * The output loads with the stock luaU_undump: only the debug arrays differ, never their format.
 * The source is compiled with mode "t": this compiler never reads bytecode.
 *
 * Interface (a WASI reactor; the host instantiates it once per compile):
 *   sg_alloc / sg_free                       buffers in the module's memory
 *   sg_compile(src, n, name, n, dump, n, mode) -> 0, or a Lua status (the instance traps on a
 *                                               Lua error: sg_error_* then holds the message)
 *   sg_out_ptr / sg_out_len                  the bytecode
 *   sg_map_ptr / sg_map_len                  SG_STRIP_FULL: int32 source line per position
 *   sg_error_ptr / sg_error_len              the message of the last error
 */
#define LUA_CORE

#include <stdlib.h>
#include <string.h>

#include "lua.h"
#include "ldebug.h"
#include "lobject.h"
#include "lstate.h"
#include "lstring.h"
#include "lundump.h"

#define SG_STRIP_NONE 0
#define SG_STRIP_NAMES 1
#define SG_STRIP_FULL 2
#define SG_STRIP_STOCK 3

#define EXPORT(name) __attribute__((export_name(#name)))

typedef struct Buffer {
    unsigned char *data;
    size_t len;
    size_t cap;
} Buffer;

static Buffer out;
static int *map = NULL;
static size_t map_len = 0, map_cap = 0;
static char error_text[1024];
static size_t error_len = 0;

static void set_error(const char *text, size_t len)
{
    if (len > sizeof error_text) len = sizeof error_text;
    memcpy(error_text, text, len);
    error_len = len;
}

__attribute__((noreturn)) void sg_throw(lua_State *L, int status)
{
    if (status == LUA_ERRMEM) set_error("not enough memory", 17);
    else if (lua_type(L, -1) == LUA_TSTRING) {
        size_t n = 0;
        const char *m = lua_tolstring(L, -1, &n);
        set_error(m, n);
    } else set_error("error object is not a string", 28);
    __builtin_trap();
}

static int grow(Buffer *b, size_t extra)
{
    size_t want = b->len + extra;
    if (want <= b->cap) return 1;
    size_t cap = b->cap ? b->cap : 4096;
    while (cap < want) cap *= 2;
    unsigned char *p = (unsigned char *)realloc(b->data, cap);
    if (p == NULL) return 0;
    b->data = p;
    b->cap = cap;
    return 1;
}

static int map_push(int line)
{
    if (map_len == map_cap) {
        size_t cap = map_cap ? map_cap * 2 : 1024;
        int *p = (int *)realloc(map, cap * sizeof *p);
        if (p == NULL) return 0;
        map = p;
        map_cap = cap;
    }
    map[map_len++] = line;
    return 1;
}

/* ------------------------------------------------------------------ the dumper (ldump.c, modes) */

typedef struct DumpState {
    int mode;
    int status;
    int position;          /* SG_STRIP_FULL: positions handed out so far */
    TString *main_source;  /* SG_STRIP_FULL: the main function's source, or NULL */
} DumpState;

static void dumpBlock(DumpState *D, const void *b, size_t size)
{
    if (D->status != 0 || size == 0) return;
    if (!grow(&out, size)) { D->status = LUA_ERRMEM; return; }
    memcpy(out.data + out.len, b, size);
    out.len += size;
}

#define dumpVector(D, v, n) dumpBlock(D, v, (n) * sizeof((v)[0]))
#define dumpLiteral(D, s) dumpBlock(D, s, sizeof(s) - sizeof(char))
#define dumpVar(D, x) dumpVector(D, &x, 1)

static void dumpByte(DumpState *D, int y)
{
    lu_byte x = (lu_byte)y;
    dumpVar(D, x);
}

#define DIBS ((sizeof(size_t) * 8 + 6) / 7)

static void dumpSize(DumpState *D, size_t x)
{
    lu_byte buff[DIBS];
    int n = 0;
    do {
        buff[DIBS - (++n)] = x & 0x7f;
        x >>= 7;
    } while (x != 0);
    buff[DIBS - 1] |= 0x80;
    dumpVector(D, buff + DIBS - n, n);
}

static void dumpInt(DumpState *D, int x) { dumpSize(D, (size_t)x); }
static void dumpNumber(DumpState *D, lua_Number x) { dumpVar(D, x); }
static void dumpInteger(DumpState *D, lua_Integer x) { dumpVar(D, x); }

static void dumpString(DumpState *D, const TString *s)
{
    if (s == NULL) dumpSize(D, 0);
    else {
        size_t size = tsslen(s);
        dumpSize(D, size + 1);
        dumpVector(D, getstr(s), size);
    }
}

static void dumpConstants(DumpState *D, const Proto *f)
{
    int i, n = f->sizek;
    dumpInt(D, n);
    for (i = 0; i < n; i++) {
        const TValue *o = &f->k[i];
        int tt = ttypetag(o);
        dumpByte(D, tt);
        switch (tt) {
        case LUA_VNUMFLT: dumpNumber(D, fltvalue(o)); break;
        case LUA_VNUMINT: dumpInteger(D, ivalue(o)); break;
        case LUA_VSHRSTR:
        case LUA_VLNGSTR: dumpString(D, tsvalue(o)); break;
        default: break; /* nil, false, true */
        }
    }
}

static void dumpFunction(DumpState *D, const Proto *f, TString *psource);

static void dumpProtos(DumpState *D, const Proto *f)
{
    int i, n = f->sizep;
    dumpInt(D, n);
    for (i = 0; i < n; i++) dumpFunction(D, f->p[i], f->source);
}

static void dumpUpvalues(DumpState *D, const Proto *f)
{
    int i, n = f->sizeupvalues;
    dumpInt(D, n);
    for (i = 0; i < n; i++) {
        dumpByte(D, f->upvalues[i].instack);
        dumpByte(D, f->upvalues[i].idx);
        dumpByte(D, f->upvalues[i].kind);
    }
}

static void dumpDebug(DumpState *D, const Proto *f)
{
    int i, n;
    int keep_lines = D->mode == SG_STRIP_NONE || D->mode == SG_STRIP_NAMES;
    int keep_names = D->mode == SG_STRIP_NONE;
    if (D->mode == SG_STRIP_FULL) {
        /* One instruction, one position: every delta is 1 from linedefined, no absolute entries. */
        dumpInt(D, f->sizecode);
        for (i = 0; i < f->sizecode; i++) dumpByte(D, 1);
        dumpInt(D, 0);
    } else {
        n = keep_lines ? f->sizelineinfo : 0;
        dumpInt(D, n);
        dumpVector(D, f->lineinfo, n);
        n = keep_lines ? f->sizeabslineinfo : 0;
        dumpInt(D, n);
        for (i = 0; i < n; i++) {
            dumpInt(D, f->abslineinfo[i].pc);
            dumpInt(D, f->abslineinfo[i].line);
        }
    }
    n = keep_names ? f->sizelocvars : 0;
    dumpInt(D, n);
    for (i = 0; i < n; i++) {
        dumpString(D, f->locvars[i].varname);
        dumpInt(D, f->locvars[i].startpc);
        dumpInt(D, f->locvars[i].endpc);
    }
    n = keep_names ? f->sizeupvalues : 0;
    dumpInt(D, n);
    for (i = 0; i < n; i++) dumpString(D, f->upvalues[i].name);
}

static void dumpFunction(DumpState *D, const Proto *f, TString *psource)
{
    int linedefined = f->linedefined, lastlinedefined = f->lastlinedefined;
    if (D->mode == SG_STRIP_FULL) {
        int pc;
        dumpString(D, psource == NULL ? D->main_source : NULL);
        linedefined = D->position;
        lastlinedefined = D->position + f->sizecode;
        for (pc = 0; pc < f->sizecode; pc++)
            if (!map_push(luaG_getfuncline(f, pc))) D->status = LUA_ERRMEM;
        D->position += f->sizecode;
    } else if (D->mode == SG_STRIP_STOCK || f->source == psource) {
        dumpString(D, NULL);
    } else {
        dumpString(D, f->source);
    }
    dumpInt(D, linedefined);
    dumpInt(D, lastlinedefined);
    dumpByte(D, f->numparams);
    dumpByte(D, f->is_vararg);
    dumpByte(D, f->maxstacksize);
    dumpInt(D, f->sizecode);
    dumpVector(D, f->code, f->sizecode);
    dumpConstants(D, f);
    dumpUpvalues(D, f);
    dumpProtos(D, f);
    dumpDebug(D, f);
}

static void dumpHeader(DumpState *D)
{
    dumpLiteral(D, LUA_SIGNATURE);
    dumpByte(D, LUAC_VERSION);
    dumpByte(D, LUAC_FORMAT);
    dumpLiteral(D, LUAC_DATA);
    dumpByte(D, sizeof(Instruction));
    dumpByte(D, sizeof(lua_Integer));
    dumpByte(D, sizeof(lua_Number));
    dumpInteger(D, LUAC_INT);
    dumpNumber(D, LUAC_NUM);
}

/* ------------------------------------------------------------------ compile */

typedef struct Source {
    const char *data;
    size_t len;
} Source;

static const char *read_source(lua_State *L, void *ud, size_t *size)
{
    Source *s = (Source *)ud;
    (void)L;
    *size = s->len;
    s->len = 0;
    return *size ? s->data : NULL;
}

static void *allocate(void *ud, void *ptr, size_t osize, size_t nsize)
{
    (void)ud;
    (void)osize;
    if (nsize == 0) {
        free(ptr);
        return NULL;
    }
    return realloc(ptr, nsize);
}

EXPORT(sg_alloc) void *sg_alloc(size_t n) { return malloc(n ? n : 1); }
EXPORT(sg_free) void sg_free(void *p) { free(p); }
EXPORT(sg_out_ptr) const unsigned char *sg_out_ptr(void) { return out.data; }
EXPORT(sg_out_len) size_t sg_out_len(void) { return out.len; }
EXPORT(sg_map_ptr) const int *sg_map_ptr(void) { return map; }
EXPORT(sg_map_len) size_t sg_map_len(void) { return map_len; }
EXPORT(sg_error_ptr) const char *sg_error_ptr(void) { return error_text; }
EXPORT(sg_error_len) size_t sg_error_len(void) { return error_len; }

/* name: the chunk name the source is compiled under ("=..." or "@..."); dump: the main function's
 * source under SG_STRIP_FULL (empty: none). Both NUL-free; their lengths exclude any NUL. */
EXPORT(sg_compile)
int sg_compile(const char *src, size_t src_len, const char *name, size_t name_len, const char *dump, size_t dump_len, int mode)
{
    lua_State *L;
    Source source;
    DumpState D;
    char *chunk_name;
    int status;

    out.len = 0;
    map_len = 0;
    error_len = 0;
    if (mode < SG_STRIP_NONE || mode > SG_STRIP_STOCK) return LUA_ERRRUN;
    L = lua_newstate(allocate, NULL);
    if (L == NULL) return LUA_ERRMEM;
    chunk_name = (char *)malloc(name_len + 1);
    if (chunk_name == NULL) return LUA_ERRMEM;
    memcpy(chunk_name, name, name_len);
    chunk_name[name_len] = '\0';
    source.data = src;
    source.len = src_len;
    status = lua_load(L, read_source, &source, chunk_name, "t");
    free(chunk_name);
    if (status != LUA_OK) return status; /* not reached on an error: the instance traps */

    memset(&D, 0, sizeof D);
    D.mode = mode;
    D.position = 0;
    D.main_source = (mode == SG_STRIP_FULL && dump_len > 0) ? luaS_newlstr(L, dump, dump_len) : NULL;
    {
        const Proto *f = clLvalue(s2v(L->top.p - 1))->p;
        dumpHeader(&D);
        dumpByte(&D, f->sizeupvalues);
        dumpFunction(&D, f, NULL);
    }
    status = D.status;
    lua_close(L);
    return status;
}
