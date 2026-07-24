#include "linker.h"

#include "lld/Common/Driver.h"
#include "llvm/Support/raw_ostream.h"

#include <cstdlib>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

LLD_HAS_DRIVER(elf)
LLD_HAS_DRIVER(macho)
LLD_HAS_DRIVER(coff)

namespace sonite::llvm_native {
namespace {

struct LinkerState {
  std::vector<std::string> objects;
  std::vector<std::string> libraries;
  std::vector<std::string> libraryPaths;
  std::vector<std::string> systemLibraries;
  std::vector<std::string> extraArgs;
  std::vector<std::string> trailingArgs;
  std::string output;
  std::string flavor = "elf"; // elf | macho | coff
  bool disposed = false;

  void dispose() { disposed = true; }
};

void LinkerFinalizer(Napi::Env, LinkerState *state) {
  if (state) {
    state->dispose();
    delete state;
  }
}

LinkerState *unwrapLinker(const Napi::CallbackInfo &info) {
  auto *state = static_cast<LinkerState *>(
      info.This()
          .As<Napi::Object>()
          .Get("state")
          .As<Napi::External<LinkerState>>()
          .Data());
  if (!state || state->disposed) {
    Napi::Error::New(info.Env(), "Linker has been disposed")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  return state;
}

Napi::Value CreateLinker(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  auto *state = new LinkerState();
  if (info.Length() >= 1 && info[0].IsObject()) {
    Napi::Object opts = info[0].As<Napi::Object>();
    if (opts.Has("flavor") && opts.Get("flavor").IsString()) {
      state->flavor = opts.Get("flavor").As<Napi::String>().Utf8Value();
    }
  }

  Napi::Object linker = Napi::Object::New(env);
  linker.Set("state", Napi::External<LinkerState>::New(env, state, LinkerFinalizer));
  return linker;
}

Napi::Value LinkerAddObject(const Napi::CallbackInfo &info) {
  LinkerState *state = unwrapLinker(info);
  if (!state)
    return info.Env().Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(info.Env(), "addObject(path) requires a path")
        .ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  state->objects.push_back(info[0].As<Napi::String>().Utf8Value());
  return info.Env().Undefined();
}

Napi::Value LinkerAddLibrary(const Napi::CallbackInfo &info) {
  LinkerState *state = unwrapLinker(info);
  if (!state)
    return info.Env().Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(info.Env(), "addLibrary(path) requires a path")
        .ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  state->libraries.push_back(info[0].As<Napi::String>().Utf8Value());
  return info.Env().Undefined();
}

Napi::Value LinkerAddLibraryPath(const Napi::CallbackInfo &info) {
  LinkerState *state = unwrapLinker(info);
  if (!state)
    return info.Env().Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(info.Env(), "addLibraryPath(path) requires a path")
        .ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  state->libraryPaths.push_back(info[0].As<Napi::String>().Utf8Value());
  return info.Env().Undefined();
}

Napi::Value LinkerAddSystemLibrary(const Napi::CallbackInfo &info) {
  LinkerState *state = unwrapLinker(info);
  if (!state)
    return info.Env().Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(info.Env(), "addSystemLibrary(name) requires a name")
        .ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  state->systemLibraries.push_back(info[0].As<Napi::String>().Utf8Value());
  return info.Env().Undefined();
}

Napi::Value LinkerAddArg(const Napi::CallbackInfo &info) {
  LinkerState *state = unwrapLinker(info);
  if (!state)
    return info.Env().Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(info.Env(), "addArg(arg) requires a string")
        .ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  state->extraArgs.push_back(info[0].As<Napi::String>().Utf8Value());
  return info.Env().Undefined();
}

Napi::Value LinkerAddTrailingArg(const Napi::CallbackInfo &info) {
  LinkerState *state = unwrapLinker(info);
  if (!state)
    return info.Env().Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(info.Env(), "addTrailingArg(arg) requires a string")
        .ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  state->trailingArgs.push_back(info[0].As<Napi::String>().Utf8Value());
  return info.Env().Undefined();
}

Napi::Value LinkerSetOutput(const Napi::CallbackInfo &info) {
  LinkerState *state = unwrapLinker(info);
  if (!state)
    return info.Env().Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(info.Env(), "setOutput(path) requires a path")
        .ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  state->output = info[0].As<Napi::String>().Utf8Value();
  return info.Env().Undefined();
}

Napi::Value LinkerLink(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  LinkerState *state = unwrapLinker(info);
  if (!state)
    return env.Undefined();
  if (state->output.empty()) {
    Napi::Error::New(env, "Linking failed:\noutput path not set")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (state->objects.empty()) {
    Napi::Error::New(env, "Linking failed:\nno object files provided")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::vector<const char *> args;
  std::vector<std::string> owned;
  owned.reserve(64);

  auto push = [&](const std::string &s) {
    owned.push_back(s);
    args.push_back(owned.back().c_str());
  };

  if (state->flavor == "macho") {
    push("ld64.lld");
  } else if (state->flavor == "coff") {
    push("lld-link");
  } else {
    push("ld.lld");
  }

  if (state->flavor == "coff") {
    push("/out:" + state->output);
  } else {
    push("-o");
    push(state->output);
  }

  for (const auto &arg : state->extraArgs) {
    push(arg);
  }
  for (const auto &path : state->libraryPaths) {
    if (state->flavor == "coff") {
      push("/libpath:" + path);
    } else {
      push("-L" + path);
    }
  }
  for (const auto &obj : state->objects) {
    push(obj);
  }
  for (const auto &lib : state->libraries) {
    push(lib);
  }
  for (const auto &sys : state->systemLibraries) {
    if (state->flavor == "coff") {
      push(sys + ".lib");
    } else {
      push("-l" + sys);
    }
  }
  for (const auto &arg : state->trailingArgs) {
    push(arg);
  }

  std::string stdoutBuf;
  std::string stderrBuf;
  llvm::raw_string_ostream stdoutOS(stdoutBuf);
  llvm::raw_string_ostream stderrOS(stderrBuf);

  bool ok = false;
  if (state->flavor == "macho") {
    ok = lld::macho::link(args, stdoutOS, stderrOS, false, false);
  } else if (state->flavor == "coff") {
    ok = lld::coff::link(args, stdoutOS, stderrOS, false, false);
  } else {
    ok = lld::elf::link(args, stdoutOS, stderrOS, false, false);
  }
  stdoutOS.flush();
  stderrOS.flush();

  if (!ok) {
    std::string message = stderrBuf.empty() ? stdoutBuf : stderrBuf;
    if (message.empty())
      message = "unknown linker error";
    Napi::Error::New(env, "Linking failed:\n" + message)
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return env.Undefined();
}

Napi::Value LinkerDispose(const Napi::CallbackInfo &info) {
  auto external = info.This().As<Napi::Object>().Get("state");
  if (external.IsExternal()) {
    auto *state = external.As<Napi::External<LinkerState>>().Data();
    if (state)
      state->dispose();
  }
  return info.Env().Undefined();
}

Napi::Value GetLldVersion(const Napi::CallbackInfo &info) {
  // Arch (and some distro) LLD packages omit Version.inc; report LLVM version.
  return Napi::String::New(info.Env(), "LLD " SONITE_LLVM_VERSION_EXPECTED);
}

} // namespace

Napi::Object InitLinker(Napi::Env env, Napi::Object exports) {
  exports.Set("createLinker", Napi::Function::New(env, CreateLinker));
  exports.Set("linkerAddObject", Napi::Function::New(env, LinkerAddObject));
  exports.Set("linkerAddLibrary", Napi::Function::New(env, LinkerAddLibrary));
  exports.Set("linkerAddLibraryPath",
              Napi::Function::New(env, LinkerAddLibraryPath));
  exports.Set("linkerAddSystemLibrary",
              Napi::Function::New(env, LinkerAddSystemLibrary));
  exports.Set("linkerAddArg", Napi::Function::New(env, LinkerAddArg));
  exports.Set("linkerAddTrailingArg",
              Napi::Function::New(env, LinkerAddTrailingArg));
  exports.Set("linkerSetOutput", Napi::Function::New(env, LinkerSetOutput));
  exports.Set("linkerLink", Napi::Function::New(env, LinkerLink));
  exports.Set("linkerDispose", Napi::Function::New(env, LinkerDispose));
  exports.Set("getLldVersion", Napi::Function::New(env, GetLldVersion));
  return exports;
}

} // namespace sonite::llvm_native
