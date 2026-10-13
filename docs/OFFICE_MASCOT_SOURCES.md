# Office mascot sources

Verified on 2026-10-13. This record separates an official source illustration from a character asset prepared for the office. An image appearing on an official website does not by itself grant a general commercial or redistribution license.

## Qwen: official capybara reference

- Official page: [Qwen Ambassador Program](https://qwen.ai/ambassador).
- The page's published frontend renders the image with the alt text `Qwen Capybara Mascot`.
- Frontend evidence: [p_ambassador-index.js](https://g.alicdn.com/qwenweb/qwen-ai-fe/0.0.85/js/p_ambassador-index.js) renders `src:d.$C`; the `$C` export in [9496.js](https://g.alicdn.com/qwenweb/qwen-ai-fe/0.0.85/js/9496.js) resolves to the original image URL below.
- Original image: [official CDN PNG](https://img.alicdn.com/imgextra/i4/O1CN01ZY8UaM1Mm3kDzu8ya_!!6000000001476-2-tps-855-855.png).
- Local reference: `design/reference/qwen-capybara-official-ambassador.png`.
- Original bytes retained without resizing, cropping, recoloring, or background editing.
- PNG: 855 × 855, RGBA, 175324 bytes.
- SHA-256: `515ff430f5fc2f9fc57832cb456a592194384c27d446031f6b72790bd3acc4ba`.
- Independent official naming evidence: [Qwen-Image-Edit announcement](https://qwen.ai/blog?id=a6f483777144685d33cd3d2af95136fcbeb57652), also retained on the [official Qwen GitHub Pages blog](https://qwenlm.github.io/blog/qwen-image-edit/), explicitly describes Capybara as Qwen's mascot.

The downloaded picture includes a desk, monitor, books, chair, headband text, and floating decorations. It is a complete illustration, not an isolated walkable character. It therefore belongs under `design/reference`, outside the packaged runtime asset list. The official blog examples also contain presentation layouts rather than isolated transparent characters.

The runtime character `web/assets/office/character-qwen-mascot.png` was prepared with the built-in imagegen tool using this official illustration as the identity reference and the user-selected `design/concepts/2026-10-13/06-minimal-editorial-office.png` as the style reference. It is **AI adapted from an official Qwen mascot reference**, not an original official asset. Its own SHA-256, dimensions and byte count are recorded in the `mascots.qwen` section of `AVATAR_SOURCES.json`.

The prompt preserves the tan capybara, broad brown muzzle, small round ears, calm face, tuft and plain purple headband. It removes the desk, monitor, chair, books, floating decorations and all text; adds a complete compact body with short paws; and uses a warm minimal cartoon contour with transparent alpha. The Qwen provider logo is displayed separately using the existing official identity asset.

## Claude / Clawd

The bounded source review checked [Claude Code's official product page](https://claude.com/product/claude-code), [official overview documentation](https://code.claude.com/docs/en/overview), and the public file tree of [anthropics/claude-code](https://github.com/anthropics/claude-code). No isolated official transparent Clawd character asset was obtained in this review. The product page's accessible raster illustrations are interface screenshots, not stand-alone mascot sprites. No installed Claude CLI executable or npm package was found in the standard user CLI directories checked; no software was installed or run to obtain art.

Search results contained community artwork and unrelated mascot token sites. Those were excluded as runtime sources. A user-authored issue in an official GitHub repository is not treated as an official brand asset declaration.

For this release, use the generic robot with the independently sourced Claude provider badge until a verified character source or a clearly labeled user-supplied replacement is available. This is a source-availability result, not a claim that Anthropic has no mascot.

## Other providers

Codex, Grok, and Cursor remain generic robot characters with their existing provider badges. Their logo sources are recorded in `web/assets/office/AVATAR_SOURCES.json`; this review does not invent a mascot for them. The existing official Doubao avatar can continue to identify the provider, while a full character remains a configurable user choice.

No unofficial fan sprites were copied into this project. Runtime rendering should use local packaged files and avoid remote image requests.
