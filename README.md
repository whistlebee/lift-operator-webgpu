# Lift Operator — browser WebGPU agent

[Watch the agent](https://whistlebee.github.io/lift-operator-webgpu/?simulation=true) · [Original game](https://github.com/gregorycwhill/Lift-Operator)

This is a clone of Gregory Hill's Lift Operator with a trained campaign agent running inside your browser. Neural inference uses WebGPU; no Python, native executable, inference service, or API key is required.

## Run a campaign

Open the link above in a browser with WebGPU enabled. Click **Run campaign** in the agent bar. It starts at round 1 with zero credits, carries earned credits forward, and stops on the first failed round. **Allow retries** is off by default. Choose **Max** speed to watch faster, or pause and inspect. A standalone round uses the selected round, credits, and seed instead.

The campaign's endurance round ends by natural death, as defined by the original game; it is not a survival-until-a-short-timeout shortcut. Round mode and retry-enabled campaigns are not the benchmark protocol.

## What the agent is

The frozen agent combines a shared passenger encoder, four 64-wide recurrent layers, learned routing/item heads, fitted per-round dispatch controllers, and a paid-shop spending planner. Some behaviors are explicit rules, including the public-history VIP reservation. This is a hybrid learned-and-programmed policy, not a claim that unassisted PPO learned the whole game.

It receives structured current game state, including exact passenger queues and lift positions, rather than screenshots. Hidden future passenger destinations and VIP return schedules are excluded from its observation. Publicly observed past VIP trips can be remembered. All lifts are manually commanded, with one decision every 15 simulation frames (4 decisions per second). Purchases are charged at the game's normal prices, with normal unlocks and no free inventory or starting credits.

## Evaluation

The release completed **1,017 of 1,024 fresh campaigns (99.32%)**, averaging **24.92 of 25 rounds**. The prior policy completed 1,010/1,024 (98.63%) on the same seeds.

Final release results and protocol are recorded in [evaluation.json](evaluation.json). A full-campaign win means all 25 authored rounds cleared in a single attempt. These are native GPU evaluation results; browser parity checks are a separate port-validation measurement. Floating-point differences across GPUs can change individual decisions, so the measured rate is not a guarantee for every browser or seed.

The browser also completed one entire original-game campaign with no retries, checking 18,584 requests against a native shadow with **zero action mismatches**. The shadow did not control the game.

The accepted release freezes performance rather than claiming a perfect success rate. Model and controller files are verified against [policy-manifest.json](policy-manifest.json) when loaded.

## Files and local serving

- `webgpu/`: FP32 neural kernels, sampling, routing, item and campaign controllers.
- `policy/`: frozen weights and controller configuration; no optimizer state.
- `bogeo-driver.js`: original-game observation/action bridge and campaign controls.
- `bogeo-adapter.js`, `bogeo-shop.js`: deterministic simulation and paid-shop adapters.

Serve the repository with any static HTTP server; do not open `index.html` using a file URL. WebGPU requires a secure context (HTTPS or localhost). With Node installed, `node tests/test-server.js` starts the existing local server. Add `?simulation=true` to its URL. No compilation or dependency installation is needed for the deployed site.

## Credits and licence

Original game, artwork and game design: **Gregory Hill**. Original repository history is retained, based on commit `2e082ddbc8a8180cc8cc6466b77619003721f9c2`. Browser agent integration and inference files were added in November 2026. Original documentation remains in [UPSTREAM_README.md](UPSTREAM_README.md).

The code and modifications are distributed under [GPL-3.0-only](LICENSE). See [NOTICE.md](NOTICE.md), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for upstream asset and audio attribution and applicable terms.
