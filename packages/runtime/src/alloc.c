#include <stdlib.h>

#include "gc.h"
#include "tsn/runtime.h"

void *tsn_alloc(int64_t size) {
  if (size < 0) {
    abort();
  }
  tsn_gc_maybe_collect();
  void *ptr = malloc((size_t)size);
  if (ptr == NULL) {
    abort();
  }
  tsn_gc_register(ptr, size);
  return ptr;
}

void *tsn_realloc(void *ptr, int64_t size) {
  if (size < 0) {
    abort();
  }
  tsn_gc_maybe_collect();
  if (ptr == NULL) {
    return tsn_alloc(size);
  }
  /* Resolve side-table index before realloc may move/free the block. */
  int32_t index = tsn_gc_find_index(ptr);
  void *next = realloc(ptr, (size_t)size);
  if (next == NULL) {
    abort();
  }
  tsn_gc_update_at(index, next, size);
  return next;
}

void tsn_free(void *ptr) {
  if (ptr == NULL) {
    return;
  }
  tsn_gc_unregister(ptr);
  free(ptr);
}
