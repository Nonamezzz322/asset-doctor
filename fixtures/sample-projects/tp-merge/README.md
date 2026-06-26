# tp-merge

Two under-filled 256×256 TexturePacker atlases (~12.5% occupancy each). Their content fits in a
single sheet, so **atlas-merge** fires. Used to verify the non-drop-in "merge atlases" fix mode
(which combines them into one sheet and rewrites manifest references).
