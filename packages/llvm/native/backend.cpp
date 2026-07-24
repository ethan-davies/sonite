#include "backend.h"

#include <llvm-c/Analysis.h>
#include <llvm-c/Core.h>
#include <llvm-c/IRReader.h>
#include <llvm-c/Support.h>
#include <llvm-c/Target.h>
#include <llvm-c/TargetMachine.h>
#include <llvm/Config/llvm-config.h>

#include <cstring>
#include <mutex>
#include <string>

namespace sonite::llvm_native {
namespace {

std::once_flag g_llvmInitFlag;
bool g_llvmInitOk = false;

void ensureLlvmInitialized(Napi::Env env, bool *ok) {
  *ok = true;
  std::call_once(g_llvmInitFlag, []() {
    LLVMInitializeAllTargetInfos();
    LLVMInitializeAllTargets();
    LLVMInitializeAllTargetMCs();
    LLVMInitializeAllAsmPrinters();
    LLVMInitializeAllAsmParsers();
    g_llvmInitOk = true;
  });
  if (!g_llvmInitOk) {
    *ok = false;
    Napi::Error::New(env, "Failed to initialize LLVM target.")
        .ThrowAsJavaScriptException();
  }
}

LLVMCodeGenOptLevel toOptLevel(const std::string &level) {
  if (level == "O0")
    return LLVMCodeGenLevelNone;
  if (level == "O1")
    return LLVMCodeGenLevelLess;
  if (level == "O2")
    return LLVMCodeGenLevelDefault;
  if (level == "O3")
    return LLVMCodeGenLevelAggressive;
  return LLVMCodeGenLevelDefault;
}

LLVMRelocMode toRelocMode(const std::string &mode) {
  if (mode == "static")
    return LLVMRelocStatic;
  if (mode == "pic")
    return LLVMRelocPIC;
  if (mode == "dynamic-no-pic")
    return LLVMRelocDynamicNoPic;
  return LLVMRelocPIC;
}

LLVMCodeModel toCodeModel(const std::string &model) {
  if (model == "small")
    return LLVMCodeModelSmall;
  if (model == "kernel")
    return LLVMCodeModelKernel;
  if (model == "medium")
    return LLVMCodeModelMedium;
  if (model == "large")
    return LLVMCodeModelLarge;
  return LLVMCodeModelDefault;
}

std::string takeMessage(char *msg) {
  if (!msg)
    return {};
  std::string out(msg);
  LLVMDisposeMessage(msg);
  return out;
}

struct BackendState {
  LLVMContextRef context = nullptr;
  LLVMModuleRef module = nullptr;
  LLVMTargetMachineRef targetMachine = nullptr;
  std::string triple;
  bool disposed = false;

  void dispose() {
    if (disposed)
      return;
    disposed = true;
    if (targetMachine) {
      LLVMDisposeTargetMachine(targetMachine);
      targetMachine = nullptr;
    }
    if (module) {
      LLVMDisposeModule(module);
      module = nullptr;
    }
    if (context) {
      LLVMContextDispose(context);
      context = nullptr;
    }
  }

  ~BackendState() { dispose(); }
};

void Finalizer(Napi::Env, BackendState *state) {
  if (state) {
    state->dispose();
    delete state;
  }
}

BackendState *unwrap(const Napi::CallbackInfo &info) {
  auto *state = static_cast<BackendState *>(
      info.This().As<Napi::Object>().Get("state").As<Napi::External<BackendState>>().Data());
  if (!state || state->disposed) {
    Napi::Error::New(info.Env(), "Backend has been disposed")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  return state;
}

Napi::Value GetLlvmVersion(const Napi::CallbackInfo &info) {
  return Napi::String::New(info.Env(), LLVM_VERSION_STRING);
}

Napi::Value GetExpectedLlvmVersion(const Napi::CallbackInfo &info) {
  return Napi::String::New(info.Env(), SONITE_LLVM_VERSION_EXPECTED);
}

Napi::Value GetDefaultTriple(const Napi::CallbackInfo &info) {
  bool ok = false;
  ensureLlvmInitialized(info.Env(), &ok);
  if (!ok)
    return info.Env().Undefined();
  char *triple = LLVMGetDefaultTargetTriple();
  auto result = Napi::String::New(info.Env(), triple ? triple : "");
  if (triple)
    LLVMDisposeMessage(triple);
  return result;
}

Napi::Value GetHostCpu(const Napi::CallbackInfo &info) {
  bool ok = false;
  ensureLlvmInitialized(info.Env(), &ok);
  if (!ok)
    return info.Env().Undefined();
  char *cpu = LLVMGetHostCPUName();
  auto result = Napi::String::New(info.Env(), cpu ? cpu : "generic");
  if (cpu)
    LLVMDisposeMessage(cpu);
  return result;
}

Napi::Value GetHostFeatures(const Napi::CallbackInfo &info) {
  bool ok = false;
  ensureLlvmInitialized(info.Env(), &ok);
  if (!ok)
    return info.Env().Undefined();
  char *features = LLVMGetHostCPUFeatures();
  auto result = Napi::String::New(info.Env(), features ? features : "");
  if (features)
    LLVMDisposeMessage(features);
  return result;
}

Napi::Value CreateBackend(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "createBackend(ir: string) requires IR string")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  bool ok = false;
  ensureLlvmInitialized(env, &ok);
  if (!ok)
    return env.Null();

  const std::string ir = info[0].As<Napi::String>().Utf8Value();
  auto *state = new BackendState();
  state->context = LLVMContextCreate();

  LLVMMemoryBufferRef buffer = LLVMCreateMemoryBufferWithMemoryRangeCopy(
      ir.data(), ir.size(), "sonite.ll");
  char *parseError = nullptr;
  if (LLVMParseIRInContext2(state->context, buffer, &state->module,
                            &parseError)) {
    std::string message = takeMessage(parseError);
    LLVMDisposeMemoryBuffer(buffer);
    state->dispose();
    delete state;
    Napi::Error::New(env, "Failed to parse LLVM IR:\n" + message)
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  LLVMDisposeMemoryBuffer(buffer);

  Napi::Object backend = Napi::Object::New(env);
  backend.Set("state", Napi::External<BackendState>::New(env, state, Finalizer));
  return backend;
}

Napi::Value BackendTarget(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  BackendState *state = unwrap(info);
  if (!state)
    return env.Undefined();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "target(config) requires a config object")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object config = info[0].As<Napi::Object>();
  std::string triple =
      config.Has("triple") && config.Get("triple").IsString()
          ? config.Get("triple").As<Napi::String>().Utf8Value()
          : "";
  std::string cpu = config.Has("cpu") && config.Get("cpu").IsString()
                        ? config.Get("cpu").As<Napi::String>().Utf8Value()
                        : "generic";
  std::string features =
      config.Has("features") && config.Get("features").IsString()
          ? config.Get("features").As<Napi::String>().Utf8Value()
          : "";
  std::string optLevel =
      config.Has("optLevel") && config.Get("optLevel").IsString()
          ? config.Get("optLevel").As<Napi::String>().Utf8Value()
          : "O0";
  std::string relocModel =
      config.Has("relocModel") && config.Get("relocModel").IsString()
          ? config.Get("relocModel").As<Napi::String>().Utf8Value()
          : "pic";
  std::string codeModel =
      config.Has("codeModel") && config.Get("codeModel").IsString()
          ? config.Get("codeModel").As<Napi::String>().Utf8Value()
          : "default";

  if (triple.empty()) {
    char *defaultTriple = LLVMGetDefaultTargetTriple();
    triple = defaultTriple ? defaultTriple : "";
    if (defaultTriple)
      LLVMDisposeMessage(defaultTriple);
  }

  char *error = nullptr;
  LLVMTargetRef target = nullptr;
  if (LLVMGetTargetFromTriple(triple.c_str(), &target, &error)) {
    std::string message = takeMessage(error);
    Napi::Error::New(env,
                     "Target '" + triple +
                         "' is not supported by the installed Sonite toolchain." +
                         (message.empty() ? "" : "\n" + message))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (state->targetMachine) {
    LLVMDisposeTargetMachine(state->targetMachine);
    state->targetMachine = nullptr;
  }

  state->targetMachine = LLVMCreateTargetMachine(
      target, triple.c_str(), cpu.c_str(), features.c_str(), toOptLevel(optLevel),
      toRelocMode(relocModel), toCodeModel(codeModel));
  if (!state->targetMachine) {
    Napi::Error::New(env, "Failed to initialize LLVM target.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  state->triple = triple;
  LLVMSetTarget(state->module, triple.c_str());
  LLVMTargetDataRef dataLayout = LLVMCreateTargetDataLayout(state->targetMachine);
  char *layoutStr = LLVMCopyStringRepOfTargetData(dataLayout);
  if (layoutStr) {
    LLVMSetDataLayout(state->module, layoutStr);
    LLVMDisposeMessage(layoutStr);
  }
  LLVMDisposeTargetData(dataLayout);

  return env.Undefined();
}

Napi::Value BackendVerify(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  BackendState *state = unwrap(info);
  if (!state)
    return env.Undefined();

  char *message = nullptr;
  if (LLVMVerifyModule(state->module, LLVMReturnStatusAction, &message)) {
    std::string detail = takeMessage(message);
    Napi::Error::New(env, "LLVM IR verification failed:\n" + detail)
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (message)
    LLVMDisposeMessage(message);
  return env.Undefined();
}

Napi::Value BackendEmitObject(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  BackendState *state = unwrap(info);
  if (!state)
    return env.Undefined();
  if (!state->targetMachine) {
    Napi::Error::New(env, "Failed to emit object file:\ntarget not configured")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "emitObject(path) requires a path string")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string path = info[0].As<Napi::String>().Utf8Value();
  char *error = nullptr;
  if (LLVMTargetMachineEmitToFile(state->targetMachine, state->module,
                                  path.c_str(), LLVMObjectFile, &error)) {
    std::string detail = takeMessage(error);
    Napi::Error::New(env, "Failed to emit object file:\n" + detail)
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return env.Undefined();
}

Napi::Value BackendDispose(const Napi::CallbackInfo &info) {
  auto external = info.This().As<Napi::Object>().Get("state");
  if (external.IsExternal()) {
    auto *state = external.As<Napi::External<BackendState>>().Data();
    if (state)
      state->dispose();
  }
  return info.Env().Undefined();
}

Napi::Value BackendGetTriple(const Napi::CallbackInfo &info) {
  BackendState *state = unwrap(info);
  if (!state)
    return info.Env().Undefined();
  return Napi::String::New(info.Env(), state->triple);
}

} // namespace

Napi::Object InitBackend(Napi::Env env, Napi::Object exports) {
  exports.Set("getLlvmVersion", Napi::Function::New(env, GetLlvmVersion));
  exports.Set("getExpectedLlvmVersion",
              Napi::Function::New(env, GetExpectedLlvmVersion));
  exports.Set("getDefaultTriple", Napi::Function::New(env, GetDefaultTriple));
  exports.Set("getHostCpu", Napi::Function::New(env, GetHostCpu));
  exports.Set("getHostFeatures", Napi::Function::New(env, GetHostFeatures));
  exports.Set("createBackend", Napi::Function::New(env, CreateBackend));
  exports.Set("backendTarget", Napi::Function::New(env, BackendTarget));
  exports.Set("backendVerify", Napi::Function::New(env, BackendVerify));
  exports.Set("backendEmitObject", Napi::Function::New(env, BackendEmitObject));
  exports.Set("backendDispose", Napi::Function::New(env, BackendDispose));
  exports.Set("backendGetTriple", Napi::Function::New(env, BackendGetTriple));
  return exports;
}

} // namespace sonite::llvm_native
