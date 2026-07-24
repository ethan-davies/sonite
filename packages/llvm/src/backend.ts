import {
  loadNative,
  type NativeBackendHandle,
  type NativeBinding,
} from "./native.js";
import { resolveOptLevel, type OptLevel } from "./opt.js";

export type RelocModel = "static" | "pic" | "dynamic-no-pic";
export type CodeModel = "default" | "small" | "kernel" | "medium" | "large";

export interface TargetConfig {
  readonly triple?: string;
  readonly cpu?: string;
  readonly features?: string;
  readonly optLevel?: OptLevel;
  readonly relocModel?: RelocModel;
  readonly codeModel?: CodeModel;
  readonly release?: boolean;
}

/**
 * Compiler-facing LLVM backend: parse IR → configure target → verify → emit object.
 */
export class Backend {
  private readonly native: NativeBinding;
  private readonly handle: NativeBackendHandle;
  private disposed = false;

  private constructor(native: NativeBinding, handle: NativeBackendHandle) {
    this.native = native;
    this.handle = handle;
  }

  static fromIr(ir: string): Backend {
    const native = loadNative();
    return new Backend(native, native.createBackend(ir));
  }

  target(config: TargetConfig = {}): void {
    this.assertAlive();
    const policy: { release?: boolean; optLevel?: OptLevel } = {};
    if (config.release !== undefined) {
      policy.release = config.release;
    }
    if (config.optLevel !== undefined) {
      policy.optLevel = config.optLevel;
    }
    const optLevel = resolveOptLevel(policy);
    const payload: Record<string, string> = {
      optLevel,
      relocModel: config.relocModel ?? "pic",
      codeModel: config.codeModel ?? "default",
      cpu: config.cpu ?? this.native.getHostCpu(),
      features: config.features ?? this.native.getHostFeatures(),
    };
    if (config.triple) {
      payload.triple = config.triple;
    }
    this.native.backendTarget.call(this.handle, payload);
  }

  verify(): void {
    this.assertAlive();
    this.native.backendVerify.call(this.handle);
  }

  emitObject(path: string): void {
    this.assertAlive();
    this.native.backendEmitObject.call(this.handle, path);
  }

  getTriple(): string {
    this.assertAlive();
    return this.native.backendGetTriple.call(this.handle);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.native.backendDispose.call(this.handle);
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error("Backend has been disposed");
    }
  }
}
