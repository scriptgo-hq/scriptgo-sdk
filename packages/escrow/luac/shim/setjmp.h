/* The compiler never calls setjmp/longjmp (see sg_config.h); ldo.c only needs the header to parse. */
#ifndef SG_SHIM_SETJMP_H
#define SG_SHIM_SETJMP_H
typedef int jmp_buf[1];
#endif
