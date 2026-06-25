# fixtures/sample-projects

Synthetic, deterministic problem-atlases used to calibrate analysis thresholds and to
regression-test parsers. Each case lives in its own folder with the atlas image, its
manifest (TexturePacker Hash/Array or PixiJS), an `expected.json` golden, and a one-line
README describing the defect it encodes.

Generate new cases with the `make-fixture` skill. Keep numbers round so occupancy and
areas stay hand-verifiable; no randomness that would break goldens.

_Cases are added during Milestone 1._
