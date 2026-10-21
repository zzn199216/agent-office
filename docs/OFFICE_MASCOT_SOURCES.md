# Office art sources

Current runtime assets are local files under `web/assets/office`. Their asset paths, dimensions, byte counts and SHA-256 hashes are recorded in `web/assets/office/AVATAR_SOURCES.json` and checked by the office asset tests. Rendering does not download images from the source links below.

## Project artwork

The pixel characters, avatar variants and pixel desk are project-original artwork defined in `web/pixel-art.js` and exported by `scripts/generate-pixel-art.cjs`. They are not official provider logos or mascots.

The four modular images—`furniture-desk.png`, `furniture-beanbag.png`, `character-robot.png` and `prop-plant.png`—were generated with the built-in imagegen tool on 2026-10-13. Their style reference is preserved in Git history: [selected office concept](https://github.com/zzn199216/agent-office/blob/6268b1731c37fc23645af809d0de48d6c066a2c9/design/concepts/2026-10-13/06-minimal-editorial-office.png). Historical concepts are no longer needed in the working tree or build.

## Archived Qwen reference

The 2026-10-13 source review retained a Qwen capybara illustration from the [Qwen Ambassador Program](https://qwen.ai/ambassador) as research material. The original reference remains accessible in [Git history](https://github.com/zzn199216/agent-office/blob/6268b1731c37fc23645af809d0de48d6c066a2c9/design/reference/qwen-capybara-official-ambassador.png): 855 × 855 RGBA, 175324 bytes, SHA-256 `515ff430f5fc2f9fc57832cb456a592194384c27d446031f6b72790bd3acc4ba`.

This illustration and an earlier mascot adaptation are not part of the current runtime asset list. The current metadata has no `mascots.qwen` entry. Historical research does not establish redistribution rights or provider endorsement; current runtime characters use the project artwork described above.
