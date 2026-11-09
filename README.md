# Lift Operator — distilled browser agent

[Watch the agent](https://whistlebee.github.io/lift-operator-webgpu/?simulation=true&policy=distilled-20261109) · [Original game](https://github.com/gregorycwhill/Lift-Operator)

A trained campaign agent runs in your browser using WebGPU. No Python, native
executable, inference service or API key is required.

## Run a campaign

Open the link in a WebGPU-capable browser and click **Run campaign**. It starts
round 1 with zero credits, uses ordinary paid purchases and earned credit
carryover, and stops at the first failed round. **Allow retries** is off by
default. Select **Max** speed to watch faster, or pause to inspect the game.
Standalone round mode uses the selected round and starting credits instead.

The endurance round completes by natural death as defined by the original game;
it is not a short survival-time shortcut. Retry-enabled and standalone runs are
not the full-campaign benchmark protocol.

## The deployed policy

This release uses a shared learned **shop network** and a shared learned
**lift–floor scorer**, alongside the existing passenger encoder, four 64-wide
recurrent layers, routing and item-use networks. The lift and shop heads were
distilled from a qualified controller. This is not a claim that unassisted PPO
learned the complete game.

The runtime no longer loads the per-round dispatch files, coupled/capsule
controller files, private VIP-reservation rule, credit reserve tables or basket
substitution plans. Learned shop choices go through the game's ordinary checkout.
The retained item-use timing, base-policy settings and round-21 shop-memory reset
match the evaluated policy; removing those would change its behaviour.

Inputs are structured current game state, including passenger queues and lift
positions, rather than screenshots. Hidden future passenger/VIP schedules are
excluded. Publicly observed VIP history and recurrent state can be remembered.
All lifts are commanded manually at 15 simulation frames per decision. There are
no free purchases, supplied inventory or bonus starting credits.

## Independent evaluation

The frozen distilled checkpoint completed **2,011/2,048 fresh campaigns (98.19%)**.
Its 95% Wilson interval is **97.52–98.69%**. The teacher completed 2,024/2,048
(98.83%) on the same seeds. This confirms high campaign reliability, not perfect
success or statistical equivalence to the teacher.

The panel was fixed before evaluation; no training or checkpoint selection took
place during confirmation. Details, per-batch outcomes and checkpoint identity
are recorded in [evaluation.json](evaluation.json). A win means all 25 authored
rounds completed in one attempt.

The browser completed one full original-game campaign with no retries. Of
18,336 native-shadow comparisons, 18,334 actions matched exactly; two differed
by no more than a single FP32 score rounding step.
No larger action-ranking difference occurred. The native worker never controlled
the game. A separate fixed-input GPU check passed 409,600 feature and 980 legal
score comparisons across all 25 rounds.

Those are native GPU simulation results. Browser validation is a separate port
check, not a 2,048-campaign browser benchmark. FP32 rounding varies between GPU
implementations; equal or nearly equal action scores can resolve differently.
Model assets are SHA-256 verified against [policy-manifest.json](policy-manifest.json).

## Files and local serving

- `webgpu/<content-hash>/`: base inference, distilled heads and retained item timing.
- `policy/`: frozen weights and minimal inference configuration; no optimizer state.
- `bogeo-driver.js`: original-game observation/action bridge and campaign controls.
- `bogeo-adapter.js`, `bogeo-shop.js`: deterministic simulation and paid-shop adapters.

Serve the repository with a static HTTP server rather than opening `index.html`
as a file. WebGPU requires HTTPS or localhost. With Node installed,
`node tests/test-server.js` starts the existing local server. No compilation or
package installation is required to use the deployed site.

## Credits and licence

Original game, artwork and game design: **Gregory Hill**. Original repository
history is retained, based on commit `2e082ddbc8a8180cc8cc6466b77619003721f9c2`.
Original documentation remains in [UPSTREAM_README.md](UPSTREAM_README.md).

Code and modifications are distributed under [GPL-3.0-only](LICENSE). See
[NOTICE.md](NOTICE.md), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for upstream asset and audio
attribution and applicable terms.
