# pixi-packed-ok

PixiJS spritesheet format — structurally the TexturePacker Hash schema but **without**
`meta.app`, which is how the parser tags the source as `pixi`. Healthy atlas: ~91%
occupancy on a 1024×1024 power-of-two sheet, not oversize → zero problem findings. This is
the baseline that proves a clean atlas stays clean.
