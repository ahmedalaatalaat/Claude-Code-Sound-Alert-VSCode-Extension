# v1.6.0 review remediation

This file maps the v1.5.1 review findings to the v1.6.0 implementation.

## Blocker / High

- **B1** Fixed — folder-scoped event-settings targeting was removed. `eventSettings` is application-scoped and writes are global/user-level.
- **B2** Fixed — commands and the status bar register before migrations; every migration is isolated with error logging so activation continues.
- **B3** Fixed — hook installation is generated only from enabled alerts. Event enablement and watched-file changes trigger a debounced hook reconcile.
- **B4** Fixed — hook status compares exact event/matcher/handler signatures, token/path, and target liveness. Stale managed hooks are automatically reconciled.
- **B5** Fixed — router takeover binds the replacement listener first and uses a short-lived exclusive takeover lock before switching.
- **B6** Fixed — internal HTTP clients use `agent:false` / `Connection: close`; teardown closes idle/all connections.
- **B7** Fixed — `deactivate()` awaits cleanup and removes the registry entry synchronously first.
- **H1** Fixed — Windows playback no longer uses `System.Media.SoundPlayer`; it calls native WinMM `PlaySound` through PowerShell, with PowerShell 5.1 and PowerShell 7 fallbacks and actionable errors.
- **H2** Fixed — PCM `WAVE_FORMAT_EXTENSIBLE` is accepted when the full PCM SubFormat GUID is present.
- **H3** Fixed — sound file existence/type is checked before playback and before the 100% volume fast path.
- **H4** Fixed — playback is serialized with a bounded global queue.
- **H5** Fixed — listener uses a per-install random token, validates Host, rejects unknown paths, caps request size, and `/health` does not expose workspace roots.
- **H6** Fixed — Claude settings mutations use an exclusive lock, re-read inside the lock, parse JSON/JSONC, and patch only the top-level `hooks` value while preserving unrelated comments/order/formatting.

## Medium

- **M1** Fixed — UI state pushes are debounced, settings reads have a short cache, and event mutations receive a targeted card update rather than an immediate full state rebuild.
- **M2** Fixed — ordinary per-event changes update the affected card in place; full render is reserved for structural/global state changes.
- **M3** Fixed — heartbeat interval is 12 seconds, stale-listener tolerance is 45 seconds, and router checks back off to roughly 18–25 seconds with jitter.
- **M4** Fixed — global enablement relies on the configuration-change listener for listener restart; the webview handler does not directly restart it.
- **M5** Fixed — only `onStartupFinished` remains in `activationEvents`.
- **M6** Fixed — capabilities for Workspace Trust and virtual workspaces are declared.
- **M7** Fixed — listener port/range are machine-scoped; event configuration is application-scoped.
- **M8** Fixed — hook status has a dedicated `error` state instead of presenting read failures as `0/0` incomplete.
- **M9** Fixed — generated audio cache is pruned on activation (14-day age limit, then 50-file cap).
- **M10** Fixed — arbitrary payload values are stringified safely, whitespace-normalized, and truncated before logs/toasts.
- **M11** Fixed — HTTP routing parses URL pathnames, so query strings do not break endpoint matching.
- **M12** Fixed — the v1.4 primary-default migration does not write `eventSettings` on a fresh/default install.

## Low / polish

- **L1** Fixed — the old relay shell-string escaping path was removed; command hooks use `command` + `args` exec form.
- **L2** Fixed — `.vscodeignore` excludes VCS/dev/test/source-conversion artifacts and maps.
- **L3** Runtime portion is not a defect. This private sideload build intentionally keeps `publisher: "local"` to preserve the existing extension identity (`local.claude-code-sound-alerts`). Marketplace publication requires the owner's real Marketplace publisher ID and real repository/homepage/bugs URLs; inventing those would be incorrect and changing the publisher would make this a different extension for existing installations.
- **L4** Fixed — icon is 256×256 PNG.
- **L5** Fixed — deprecated v1.2 settings are no longer contributed; migration reads them privately with `inspect()`.
- **L6** Fixed — README documents Windows, macOS, and Linux audio requirements.
- **L7** Fixed — redundant checkbox ARIA state is absent; sound/volume/repeat controls have explicit label associations.
- **L8** Fixed — webview `localResourceRoots` is restricted to the extension `media/` directory.
- **L9** Fixed — `retainContextWhenHidden` is disabled and view state is persisted with webview state APIs.
- **L10** Fixed — relay scripts and listener registry live under VS Code extension global storage, not `~/.claude/`.

## Platform-specific recommendations

- **Exec-form command relay** implemented (`command` + `args`, no shell-built path command).
- **Async relay / timeout** implemented for `SessionStart` and `Setup`: `async: true`, `timeout: 10`.

## Review points deliberately interpreted differently

1. **Hook-currentness in a multi-window router:** currentness cannot be defined as “URL equals this window's listener port.” v1.6 instead validates the configured router's exact managed handler shape/token and verifies the router target is alive. A different VS Code window may legitimately own that router port.
2. **Untrusted workspaces:** after moving machine/security settings out of workspace scope and because the extension does not execute workspace code, Restricted Mode support is declared `true`; virtual workspaces remain limited because workspace-affinity scoring depends on local paths.
3. **Publishing metadata:** `publisher: local` is intentionally retained for private VSIX upgrades. A real Marketplace publisher/repository cannot be truthfully supplied without owner-provided values.


# v1.6.1 second-review remediation

The v1.6.0 second review confirmed every blocker/high-severity finding from the first review was fixed. v1.6.1 closes the remaining defects/performance regression and the valid minor recommendations:

- **Lint:** added `caughtErrorsIgnorePattern`, removed dead `isOurHandlerFor`, and log takeover bind failures.
- **JSONC patcher:** tracks the last significant value character separately from the delimiter, preserves trailing comments/trivia, keeps commas with values, removes empty `hooks`, and is idempotent.
- **Fresh-install migration:** v1.3.1/v1.3.2 sound migrations now detect the absence of stored event settings and skip without writing defaults.
- **Windows playback:** WinMM helper assemblies are cached per PowerShell host under extension global storage and repeat playback occurs in one PowerShell process.
- **Probe performance:** hook-status target liveness is cached for three seconds and local ownership bypasses the network probe.
- **HTTP tolerance:** managed HTTP hooks use a 2-second timeout; malformed alert requests are logged and return 204.
- **Playback queue:** imported-sound previews use the same bounded queue as live alerts.
- **Server defense:** explicit `clientError` socket destruction is registered.
- **Tests:** source-string assertions were replaced by behavioral checks, and 31 JSONC layouts are checked for parseability/idempotence/removal.
- **Upgrade note:** README explains old workspace-scoped `eventSettings` may be flagged and should be removed.

The review's point that HTTP 400 for malformed JSON is technically valid remains true; v1.6.1 intentionally uses 204 because this extension is observational and should never create an actionable Claude hook error for malformed alert payloads.
## Third review / v1.6.2 cleanup

The third review confirmed that all previous blocker/high-severity and v1.6.1 defects were fixed. v1.6.2 closes the remaining A–F items:

- **A — stale audio DLL lock:** PowerShell now removes abandoned `.lock` files older than 30 seconds before attempting cache compilation.
- **B — audio process can hang forever:** `spawnCaptured` now has a bounded timeout and terminates hung audio hosts; timeout budgets scale with sound duration/repeats/gaps.
- **C — CRLF mixing:** JSONC value formatting uses the source file's newline style, with a hard regression assertion for zero LF-only additions to CRLF input.
- **D — whitespace residue:** hook-member removal trims only the seam indentation and collapses duplicate seam newlines, with a hard assertion that no whitespace-only line is introduced.
- **E — incomplete test docs:** README now documents the 31-shape and third-review adversarial suites.
- **F — test branch in relay path:** `relayScriptPath()` now resolves only from VS Code global storage; the test-storage fallback was removed.

Additional third-review checks cover every hook-removal index path, adjacent comments, nested braces in strings, install→uninstall→install stability, stored-event-settings semantics, the 2-second HTTP hook timeout, stale-lock script generation, and a real hung child process timeout.



## v1.6.3 Windows first-run audio hotfix

A real Windows PowerShell log exposed one host-specific gap not reproducible in the Linux packaging environment: `Add-Type -TypeDefinition ... -OutputAssembly` can emit the cached WinMM helper DLL without loading the `ClaudeSoundNative` type into that same process. v1.6.3 now checks the loaded type immediately after compilation and runs `Add-Type -Path $dll` when required before `PlaySound` is invoked. A regression assertion covers the generated PowerShell host script.


## v1.7 background-aware completion

Claude Code now reports `background_tasks` and `session_crons` on `Stop`. v1.7 treats those registries as authoritative completion state: non-empty means Background Work / Waiting, both present and empty means Main Work Finished, and missing registry data is Completion Unverified under the default strict-verification mode. `SubagentStop`, `TaskCompleted`, and notification-driven background completion are separate profiles and never map to the Done Fanfare. Current Notification subtypes and Pre/PostModelSwitch events are represented, and a dedicated v1.7 regression suite protects these semantics.

## v1.7.1 — v1.7 completion review

Addressed H1–H4 and M1–M6 from `CODE_REVIEW_v1.7.0.md`: grace-window cancellation on self-resume, registry status/type filtering, Auto/Strict/Legacy compatibility, downgrade-only waiting text, agent-context Stop suppression, parent/subagent state isolation, transition-only background sounds, v1.7 migration, internal silent state hooks, and session listener pinning. The local hook path is unified through `handleHookLocally`, completion debounce is session-aware, routed handlers acknowledge before classification, and the UI now explains the mutually exclusive Stop outcomes.

v1.7.1 deliberately did not assume teammate background-task ids were reliably equal to `TeammateIdle.agent_id`; v1.7.2 improves this by using reconstructed idle-teammate counts when direct correlation is unavailable, while keeping unmatched entries blocking.

Packaging note: the release source/VSIX keeps WAV assets only under `media/sounds/`; the v1.7.2 test suite fails if root `media/*.wav` duplicates are present. User-supplied large WAVs are preserved byte-for-byte rather than down-sampled.

Documentation note: Claude Code's public description of background-task/cron payload shapes has changed over time. v1.7.2 no longer claims a fixed documented schema; unknown task/cron shapes are handled conservatively.


## v1.7.2 — fresh v1.7.1 review remediation

- **N1 fixed:** waiting-text matching is narrower, scans only the closing two sentences, excludes user-directed waits and nearby negation, and retains downgrade-only semantics.
- **N2 fixed:** background-chain state persists across machine-injected task-notification prompts; a real user prompt starts a new chain.
- **N3 fixed:** ambient/ignored/idle-teammate opt-outs run before unknown-status conservative blocking.
- **N4 fixed:** recurring crons have a dedicated `recurringCronIteration` Stop outcome and never fall through to Main Finished.
- **N5 mitigated safely:** direct id/name matching is retained, plus an idle-teammate count budget for current payloads that expose unrelated task ids. Unmatched teammate entries remain blocking because Claude does not provide a universal correlation key.
- **N6 fixed:** hook receive timestamps are assigned before routing; grace expiry checks newer same-session activity even when processing order is reversed.
- **N7 substantially fixed:** silent state hooks use async command relays when their own alert is disabled. The core Stop hook remains HTTP by design for final-completion timing.
- **N8 fixed:** README top-level completion semantics were rewritten for v1.7.2.
- **N9 fixed:** routing metadata is assigned once and shared global-storage marker files dedupe cross-window retries.
- **N10 fixed:** unknown/non-object cron entries block conservatively.
- **N11 fixed for future/direct upgrades:** old `strictCompletionVerification=true` maps to Auto; Legacy mode skips compatibility warnings; warnings are keyed by reported Claude version when available. Existing v1.7.1 Strict users are asked before changing because intent cannot be reconstructed reliably.
- **N12 intentionally unchanged:** SessionEnd cancels pending Finished because closing/clearing a session is not proof that background work completed; avoiding a false Done sound is the extension's primary invariant.
- **N13 fixed/clarified:** documentation no longer overclaims a stable cron schema, and release packaging asserts there are no root media WAV duplicates.
