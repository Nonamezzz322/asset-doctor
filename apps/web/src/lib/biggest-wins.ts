// Re-export shim: the pure "biggest wins" ranking moved to @asset-doctor/budget so the SHARED report
// (asset-doctor audit --html / the web export buttons) ranks reclaims by the SAME rule the in-app panel
// uses — one source, zero drift ("biggest win" means the same thing everywhere). Existing web imports
// (App.tsx, components/BiggestWins.tsx) keep this path; the tests moved with the module
// (packages/budget/test/biggest-wins.test.ts).
export { biggestWins, hasWins } from '@asset-doctor/budget';
export type { BiggestWins, WinRow } from '@asset-doctor/budget';
