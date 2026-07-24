/* Windows / missing-feature stubs for the Sonite runtime.
 * Full async/net/TLS on Windows is out of scope for the initial toolchain milestone.
 */
#include "sn/runtime.h"

#include <stdio.h>
#include <stdlib.h>

#ifdef _WIN32

static void sn_win_unsupported(const char *feature) {
  fprintf(stderr,
          "error: Sonite runtime feature '%s' is not available on Windows yet.\n",
          feature);
  abort();
}

/* Reactor / async stubs */
void sn_event_loop_run(void) { sn_win_unsupported("event_loop"); }
void sn_task_spawn(void *a, void *b, void *c) {
  (void)a;
  (void)b;
  (void)c;
  sn_win_unsupported("task_spawn");
}

#endif /* _WIN32 */
