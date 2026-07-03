# tp-array-oversize

TexturePacker **Array** format. Occupancy is healthy (~86%), but the atlas is **4100×1024**:
the longest edge exceeds the 2730 crit threshold (oversize **crit**) and 4100 is not a power
of two (NPOT **warn**). No occupancy/wasted finding — dimensions are the story here.
