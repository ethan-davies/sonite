#pragma once

#include <napi.h>

namespace sonite::llvm_native {

Napi::Object InitLinker(Napi::Env env, Napi::Object exports);

} // namespace sonite::llvm_native
