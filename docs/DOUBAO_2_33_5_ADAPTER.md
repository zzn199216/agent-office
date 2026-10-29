# Doubao 2.33.5 resource qualification

The Windows product manifest reports 2.33.5. The chat page is additionally
overlaid by desktop2_web_resource 1.0.7.5786 (build commit
498c3e56bbfe539a10d5acb942a18831080783f1). The executable's Chromium version is
not the product version. A product-version check alone cannot qualify this
adapter.

`src/doubao-native-2.33.5.json` pins the chat runtime's two lazy resources:

- services: chunk 40406, `s2-onboarding-sug-direct-send.66ed51d9fb.js`
- conversations: chunk 17047, `17047.842dddf942.js`

Both retain the previously reviewed exported SDK contracts and factory hashes.
Their complete resource hashes and paths changed. The eight SDK modules are
9552, 709956, 33086, 691255, 953466, 770750, 960367 and 735341. The 144 external
dependency IDs are unchanged from the previous refresh profile.

The cold chat entry additionally loads different minified factories from
87653 (messages), 52927 (text), 54990 (store/completion), 88700 (conversation
metadata), and 67619 (account identity). Reviewed differences are local binding
names and the identity module's conditional import guards; the exported
operations, imported modules, message IDs, completion checks and account fields
remain the same. The profile accepts these exact cold hashes and the previously
reviewed warm variants. It does not accept arbitrary installed source hashes.

The old profiles remain available. Selection requires one matching complete
resource map, verifies chunk bytes and loaded factory hashes before registering
anything, and retains dependency and conversation ownership checks. Renderer
adapter revision v5 also carries the expanded exact variant catalog; active or
uncertain work still blocks replacement of an older bridge.

Static validation used the installed base resource pack plus the hot-update
pack. JavaScript was parsed as source and factory functions captured without
calling business modules. The production preparation/registration code passed
against these actual source bytes in an isolated runtime, with unexecuted stubs
for remaining preloaded dependencies. This proves source preparation, not live
login, network access, conversation recovery, or a model reply. Real-client
acceptance still requires the user's availability and an actual correlated
reply through the existing member.

On later resource changes, recheck the installed resources and SDK contracts.
Do not remove the source checks or rename an unknown build as supported.
