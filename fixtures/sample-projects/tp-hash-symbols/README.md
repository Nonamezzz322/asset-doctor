# tp-hash-symbols

TexturePacker **Hash** format. A sparse symbol sheet on a 512×512 (power-of-two) atlas:
only ~19% of the area is covered, so occupancy is **crit** and wasted-regions carries the
emptiness overlay (info). `sym_c` is trimmed and `sym_d` is rotated — they exercise
parser fidelity (the packed frame stays as-placed; source size is preserved).
