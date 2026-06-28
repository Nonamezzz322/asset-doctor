// @asset-doctor/probe — render-probe. Reusable GL instrument (device-independent, headless-
// testable) + a PixiJS v8 probe that drives it. The differentiator static analyzers can't give.

export { instrument, compressedDataByteLength } from './gl-instrument';
export type { GlStats, InstrumentHandle } from './gl-instrument';
export { probeAtlas, probeKtx2 } from './probe';
export type { ProbeReading, ProbeKtx2Reading, Ktx2TranscoderPaths } from './probe';
export { installRuntimeProfiler } from './runtime';
export type { RuntimeReport, RuntimeProfiler } from './runtime';
