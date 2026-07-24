import { cleanNativeCache } from "../deps/native-cache.js";

export function runCacheClean(): number {
  const result = cleanNativeCache();
  if (result.removed) {
    console.log(`cleaned native cache at ${result.path}`);
  } else {
    console.log(`native cache already empty (${result.path})`);
  }
  return 0;
}
