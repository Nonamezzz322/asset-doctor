// @asset-doctor/probe — render-probe. Reusable GL instrument (device-independent, headless-
// testable) + a PixiJS v8 probe that drives it. The differentiator static analyzers can't give.

export { instrument } from './gl-instrument';
export type { GlStats, InstrumentHandle } from './gl-instrument';
export { probeAtlas } from './probe';
export type { ProbeReading } from './probe';
export { installRuntimeProfiler } from './runtime';
export type { RuntimeReport, RuntimeProfiler } from './runtime';
