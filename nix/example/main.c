/* Prints a line and the zlib version it linked against. The binary lives
   only in seenix.cachix.org, and its glibc and zlib come from
   cache.nixos.org. */
#include <stdio.h>
#include <zlib.h>

int main(void) {
  printf("seenix example, linked against zlib %s\n", zlibVersion());
  return 0;
}
