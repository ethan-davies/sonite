#include <napi.h>

#include "backend.h"
#include "linker.h"

#include <llvm/Config/llvm-config.h>

#include <cstring>
#include <string>

namespace {

Napi::Value AssertLlvmVersion(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  const char *expected = SONITE_LLVM_VERSION_EXPECTED;
  // Compare major.minor (22.1) — patch may differ across distro builds.
  std::string actual = LLVM_VERSION_STRING;
  std::string expect(expected);
  auto majorMinor = [](const std::string &v) {
    auto first = v.find('.');
    if (first == std::string::npos)
      return v;
    auto second = v.find('.', first + 1);
    if (second == std::string::npos)
      return v;
    return v.substr(0, second);
  };
  if (majorMinor(actual) != majorMinor(expect)) {
    Napi::Error::New(env, "incompatible LLVM version: linked " + actual +
                              ", Sonite requires " + expect)
        .ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }
  return Napi::Boolean::New(env, true);
}

} // namespace

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  sonite::llvm_native::InitBackend(env, exports);
  sonite::llvm_native::InitLinker(env, exports);
  exports.Set("assertLlvmVersion", Napi::Function::New(env, AssertLlvmVersion));
  return exports;
}

NODE_API_MODULE(sonite_llvm, InitAll)
