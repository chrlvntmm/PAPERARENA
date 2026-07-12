import { Buffer } from "buffer";

const g = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer;
  global?: typeof globalThis;
};

if (typeof g.Buffer === "undefined") {
  g.Buffer = Buffer;
}

if (typeof g.global === "undefined") {
  g.global = globalThis;
}

export { Buffer };
