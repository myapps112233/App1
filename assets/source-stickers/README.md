# Original sticker files

These are the twelve WebP files exactly as they were uploaded to the repository
root (commit 98a31c5). They are kept for reference only and are not served by the
game.

The runtime copies live in `public/stickers`, where they were resized and
optimised for mobile play. Two of these files are animated (40 and 64 frames) and
are served as static first frames to keep sending smooth on low-end phones.

To change the collection, edit files in `public/stickers`, then run
`npm run manifest` and restart the server. See `public/stickers/LICENSE.md` for
the licensing note that must be confirmed before a public launch.
