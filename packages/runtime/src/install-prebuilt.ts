import { installHostPrebuilt } from "./index.js";

const dest = installHostPrebuilt();
console.log(`installed runtime prebuilt: ${dest}`);
