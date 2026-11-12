# Release posters

One wide and one square poster per tech update, from one HTML template (`template.html`) in the site's design
(colours and type from `web/public/style.css`, the mascot from `web/public/assets/capstan-wave.webp`, fonts copied
into `fonts/` under the SIL Open Font License 1.1). Headless Chrome screenshots each page with a throwaway profile.

| file | size | used by |
| --- | --- | --- |
| `update-NN.png` | 1600 x 900 | `bin/ghrelease.sh` (GitHub Release asset) and `bin/announce-telegram.sh` (team post) |
| `update-NN-square.png` | 1080 x 1080 | reposts |

The tag is `rr_tag_of` from `lib/common.sh`. Stage `update-NN.png` in `$RR_HOME/posters/` before the update's slot.

Each poster shows the update number, the title and the plain line from the update's CHANGELOG entry, read from a
notes folder of `NN.md` files (`# Update N: title`, then `## CHANGELOG entry`).

```sh
bun ops/release/posters/render.ts --notes <notes dir> --out <poster dir>   # all; --only 1,5 for some
bun test ops/release/posters                                                # POSTERS_DIR=<poster dir> checks all 144
```

The render shrinks a long title or line until it fits and fails if it still does not. Look at the PNGs before staging.
