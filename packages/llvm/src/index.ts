import { Backend, type TargetConfig } from "./backend.js";
import { Linker } from "./linker.js";
import {
  isNativeBindingAvailable,
  loadNative,
} from "./native.js";
import { resolveOptLevel, type OptLevel } from "./opt.js";
import {
  hostPlatformId,
  resolveTargetToolchain,
  type PlatformId,
  type TargetToolchain,
} from "./target.js";
import {
  PINNED_LLVM_VERSION,
  SUPPORTED_PLATFORMS,
  detectPlatformId,
} from "./version.js";

export function getLlvmVersion(): string {
  return loadNative().getLlvmVersion();
}

export function getLldVersion(): string {
  return loadNative().getLldVersion();
}

export function getDefaultTriple(): string {
  return loadNative().getDefaultTriple();
}

export function getHostCpu(): string {
  return loadNative().getHostCpu();
}

export function getHostFeatures(): string {
  return loadNative().getHostFeatures();
}

export {
  Backend,
  Linker,
  isNativeBindingAvailable,
  resolveOptLevel,
  hostPlatformId,
  resolveTargetToolchain,
  PINNED_LLVM_VERSION,
  SUPPORTED_PLATFORMS,
  detectPlatformId,
};
export type {
  TargetConfig,
  OptLevel,
  PlatformId,
  TargetToolchain,
};
