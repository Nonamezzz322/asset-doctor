// Minimal ambient types for the `pngjs` synchronous decoder used in fixture-decode tests
// (no @types/pngjs is installed and pngjs is a root devDependency only). Covers exactly the
// surface the tests touch: PNG.sync.read → { width, height, data }.
declare module 'pngjs' {
  export interface PNGImage {
    width: number;
    height: number;
    data: Buffer;
  }
  export const PNG: {
    sync: {
      read(buffer: Buffer | Uint8Array): PNGImage;
    };
  };
}
