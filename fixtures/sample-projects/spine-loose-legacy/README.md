# spine-loose-legacy

The **same** Spine regions and the **same** skeleton as `spine-loose`, but `skeleton.json` uses the
**legacy `skins`-OBJECT** form (`{ skinName: { slot: { att: {...} } } }`, Spine ≤3.7). Pins the
verifier's **both-shapes** coverage: `scanSkeleton` must resolve the identical required-region set and
`verifySpineSkeleton` must report `verified = 6` regardless of whether `skins` is an array (modern)
or an object (legacy). A recognized legacy shape returns `unverified:false` — never a false 0-of-0.
