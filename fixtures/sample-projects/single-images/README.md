# single-images

Standalone PNGs, no atlas/manifest. `hero.png` is 2050×2050 → oversize **warn** (edge >
2048, below the 2730 crit) and **NPOT warn**; its VRAM is 2050×2050×4 = 16,810,000 bytes.
`icon.png` is a clean 256×256. Exercises the single-image parse + dimensions on images.
