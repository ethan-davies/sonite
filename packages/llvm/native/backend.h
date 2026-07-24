#pragma once

#include <napi.h>
#include <string>

namespace sonite::llvm_native {

Napi::Object InitBackend(Napi::Env env, Napi::Object exports);

} // namespace sonite::llvm_native
