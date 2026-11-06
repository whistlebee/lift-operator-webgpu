// Metallic-ML adapter around the upstream Lift Operator simulator.
//
// This is a thin environment facade, not a reimplementation of the game.  A
// step advances the same one-second gameTick and 60 animationTick frames used
// by engine-simulator.js, after applying the requested production target
// command through setLiftTarget().
(function (global) {
    // These are the public controls exposed by the in-game Automation Dock
    // and Supply Closet. Keep the ordering stable: it is part of the padded
    // action-space ABI consumed by the Mojo policy.
    const AUTOMATION_MODES = [
        'manual', 'sweep', 'priority-sweep', 'voting',
        'weighted-voting', 'zoned-low', 'zoned-high'
    ];
    const POWERUP_IDS = [
        'wrench', 'freshener', 'musak', 'turbo', 'doors', 'tardis',
        'doubleDecker', 'openPlan', 'groupThink'
    ];

    function finiteNumber(value, fallback) {
        return Number.isFinite(Number(value)) ? Number(value) : fallback;
    }

    function fullControlEnabled() {
        return Boolean(global.__liftOperatorFullControl);
    }

    function dispatchCount(spaceFloors, spaceLifts, factorized) {
        return factorized ? spaceFloors : spaceFloors * spaceLifts;
    }

    function automationActionBase(spaceFloors, spaceLifts, factorized) {
        return dispatchCount(spaceFloors, spaceLifts, factorized) + 1;
    }

    function powerupActionBase(spaceFloors, spaceLifts, factorized) {
        return automationActionBase(spaceFloors, spaceLifts, factorized) +
            spaceLifts * AUTOMATION_MODES.length;
    }

    function automationModeLegal(mode, round) {
        const unlocks = (Config.GAME_DATA || {}).automationUnlocks || {};
        if (mode === 'manual') return true;
        if (mode === 'sweep') return round >= Number(unlocks.sweep || 2);
        if (mode === 'priority-sweep') return round >= Number(unlocks.priority || 3);
        if (mode === 'voting' || mode === 'weighted-voting') {
            return round >= Number(unlocks.voting || 5);
        }
        if (mode === 'zoned-low' || mode === 'zoned-high') return round >= 14;
        return false;
    }

    function powerupTierForInventory(id, round) {
        if (typeof PowerUps === 'undefined' || !PowerUps.catalog ||
            !PowerUps.catalog[id] || !PowerUps.isPowerUpAvailableForRound(id, round)) {
            return -1;
        }
        let best = -1;
        (PowerUps.inventory || []).forEach(function (item) {
            if (item.id !== id) return;
            const tier = Math.trunc(Number(item.tier));
            const ability = PowerUps.catalog[id].tiers[tier];
            if (ability && tier > best) best = tier;
        });
        return best;
    }

    function powerupActive(id) {
        if (typeof PowerUps === 'undefined') return false;
        if (typeof PowerUps.isGlobalPowerUpActive === 'function' &&
            PowerUps.isGlobalPowerUpActive(id)) return true;
        if (typeof PowerUps.isLiftPowerUpActive === 'function') {
            return (Registry.lifts || []).some(function (lift) {
                return PowerUps.isLiftPowerUpActive(id, lift);
            });
        }
        return false;
    }

    function makeNoopUi() {
        // The vendored engine checks UI methods before invoking them. An
        // empty object avoids 60 x lift-count function calls per simulated
        // second while preserving the same headless no-render behaviour.
        return {};
    }

    function makeNoopAudio() {
        const noop = function () {};
        return { play: noop, publish: noop, setPsi: noop, setContext: noop };
    }

    function queueFeatures(now, floor) {
        const waiting = floor.waitingGuests || [];
        let happy = 0;
        let annoyed = 0;
        let critical = 0;
        let vip = 0;
        let oldest = 0;
        waiting.forEach(function (guest) {
            const status = guest.status;
            if (status === GuestStatus.HAPPY) happy++;
            else if (status === GuestStatus.ANNOYED) annoyed++;
            else if (status === GuestStatus.CRITICAL) critical++;
            if (guest.isVip) vip++;
            oldest = Math.max(oldest, Math.max(0, now - Number(guest.spawnTime || now)) / 1000);
        });
        return [waiting.length, happy, annoyed, critical, vip, oldest];
    }

    function queuePriority(now, floor, floorIndex, currentFloor) {
        const waiting = floor.waitingGuests || [];
        let annoyed = 0;
        let critical = 0;
        let vip = 0;
        let oldestWait = 0;
        waiting.forEach(function (guest) {
            if (guest.status === GuestStatus.CRITICAL) critical++;
            else if (guest.status === GuestStatus.ANNOYED) annoyed++;
            if (guest.isVip) vip++;
            oldestWait = Math.max(oldestWait,
                Math.max(0, now - Number(guest.spawnTime || now)) / 1000);
        });
        const raw = vip * 10000000 + critical * 100000 +
            annoyed * 10000 + oldestWait * 1000 +
            waiting.length * 250 - Math.abs(floorIndex - currentFloor);
        return Math.max(0, Math.min(1, raw / 10000000));
    }

    function observation() {
        const now = global.Game.virtualTime || Date.now();
        const features = [];
        const floors = Registry.floors || [];
        const lifts = Registry.lifts || [];
        const spaceFloors = Math.max(1,
            Math.trunc(finiteNumber(global.__liftOperatorSpaceFloors, floors.length)));
        const spaceLifts = Math.max(1,
            Math.trunc(finiteNumber(global.__liftOperatorSpaceLifts, lifts.length)));
        const rich = Boolean(global.__liftOperatorRichObservation);
        const includeRound = Boolean(global.__liftOperatorIncludeRound);
        const dispatchFeatures = Boolean(global.__liftOperatorDispatchFeatures);
        const maxFloor = Math.max(1, floors.length - 1);
        if (includeRound) {
            // A scalar round number makes the shared MLP interpolate between
            // unrelated rule sets (events, hazards, and lift layouts).  Keep
            // the shape ratios, but expose a one-hot authored-level identity
            // so the trunk can learn level-specific dispatch behaviour.
            const roundIndex = Math.max(0, Math.min(24,
                Math.trunc(finiteNumber(Registry.stats.round, 1)) - 1));
            for (let index = 0; index < 25; index++) {
                features.push(index === roundIndex ? 1 : 0);
            }
            features.push(floors.length / spaceFloors, lifts.length / spaceLifts);
        }
        features.push(
            finiteNumber(Registry.stats.timeLeft, 0) / Math.max(1, Config.roundTime),
            finiteNumber(Registry.stats.lives, 0) / Math.max(1, Config.startingLives),
            finiteNumber(Registry.roundStats.servedThisRound, 0) / Math.max(1, floors.length * 2),
            finiteNumber(Registry.roundStats.guestsSpawned, 0) / Math.max(1, floors.length * 4)
        );
        let bestQueueFloor = -1;
        let bestQueuePriority = -1;
        const currentFloor = lifts.length ? Math.round(
            finiteNumber(lifts[0].pos, 0) / Registry.floorHeight
        ) : 0;
        for (let floorIndex = 0; floorIndex < spaceFloors; floorIndex++) {
            const floor = floors[floorIndex] || { waitingGuests: [] };
            const q = queueFeatures(now, floor);
            features.push(
                q[0] / 10, q[1] / 10, q[2] / 10, q[3] / 10, q[4] / 10,
                Math.min(1, q[5] / 60)
            );
            if (rich) {
                const priority = floorIndex < floors.length
                    ? queuePriority(now, floor, floorIndex, currentFloor)
                    : 0;
                features.push(priority);
                if (priority > bestQueuePriority) {
                    bestQueuePriority = priority;
                    bestQueueFloor = floorIndex;
                }
            }
        }
        if (rich) {
            for (let floorIndex = 0; floorIndex < spaceFloors; floorIndex++) {
                features.push(floorIndex === bestQueueFloor ? 1 : 0);
            }
        }
        for (let liftIndex = 0; liftIndex < spaceLifts; liftIndex++) {
            const lift = lifts[liftIndex] || null;
            const current = lift
                ? finiteNumber(lift.pos, 0) / Math.max(1, Registry.floorHeight) / maxFloor
                : 0;
            const target = lift
                ? finiteNumber(lift.targetFloor, 0) / maxFloor
                : 0;
            const passengers = lift && lift.passengers ? lift.passengers : [];
            let destinationSum = 0;
            passengers.forEach(function (guest) {
                destinationSum += finiteNumber(guest.dest, 0) / maxFloor;
            });
            features.push(
                Math.max(0, Math.min(1, current)),
                Math.max(0, Math.min(1, target)),
                passengers.length / Math.max(1, Config.liftCapacity),
                destinationSum / Math.max(1, Config.liftCapacity),
                lift && lift.state === 'IDLE' ? 1 : 0,
                lift && lift.state === 'BOARDING' ? 1 : 0,
                lift && (lift.jamTimer > 0 || lift.isJammed) ? 1 : 0,
                lift && lift.stinkTimer > 0 ? 1 : 0
            );
            if (rich) {
                const destinationHistogram = new Array(spaceFloors).fill(0);
                passengers.forEach(function (guest) {
                    const destination = Math.trunc(finiteNumber(guest.dest, -1));
                    if (destination >= 0 && destination < destinationHistogram.length) {
                        destinationHistogram[destination]++;
                    }
                });
                destinationHistogram.forEach(function (count) {
                    features.push(count / Math.max(1, Config.liftCapacity));
                });
                let passengerTarget = -1;
                if (passengers.length) {
                    const passenger = passengers.slice().sort(function (a, b) {
                        return Number(a.spawnTime || 0) - Number(b.spawnTime || 0);
                    })[0];
                    passengerTarget = Math.trunc(finiteNumber(passenger.dest, -1));
                }
                features.push(
                    passengerTarget >= 0
                        ? (passengerTarget + 1) / Math.max(1, floors.length)
                        : 0
                );
                for (let floorIndex = 0; floorIndex < spaceFloors; floorIndex++) {
                    features.push(floorIndex === passengerTarget ? 1 : 0);
                }
            }
        }
        if (dispatchFeatures) {
            // Action-indexed state features make the fixed padded action space
            // easier for a feed-forward policy to learn.  They are computed
            // solely from the visible queue/passenger state; the heuristic
            // action selector below is not consulted.  Keep the same
            // comparator terms as the upstream-facing dispatch observation,
            // with one score per (lift, floor) action.
            for (let liftIndex = 0; liftIndex < spaceLifts; liftIndex++) {
                const lift = lifts[liftIndex] || null;
                const current = lift
                    ? Math.round(Number(lift.pos || 0) / Registry.floorHeight)
                    : 0;
                for (let floorIndex = 0; floorIndex < spaceFloors; floorIndex++) {
                    let score = 0;
                    if (lift && lift.passengers && lift.passengers.length) {
                        let count = 0;
                        let critical = 0;
                        let annoyed = 0;
                        let oldestWait = 0;
                        lift.passengers.forEach(function (passenger) {
                            if (Math.trunc(Number(passenger.dest)) !== floorIndex) return;
                            count++;
                            if (passenger.status === 'critical') critical++;
                            else if (passenger.status === 'annoyed') annoyed++;
                            oldestWait = Math.max(oldestWait,
                                Math.max(0, (global.Game.virtualTime || Date.now()) -
                                    Number(passenger.spawnTime || 0)) / 1000);
                        });
                        score = count * 100000 + critical * 10000 +
                            annoyed * 1000 + oldestWait -
                            Math.abs(floorIndex - current);
                        score /= 1000000;
                    } else if (floorIndex < floors.length) {
                        const waiting = floors[floorIndex].waitingGuests || [];
                        let vip = 0;
                        let critical = 0;
                        let annoyed = 0;
                        let oldestWait = 0;
                        waiting.forEach(function (guest) {
                            if (guest.isVip) vip++;
                            if (guest.status === GuestStatus.CRITICAL) critical++;
                            else if (guest.status === GuestStatus.ANNOYED) annoyed++;
                            oldestWait = Math.max(oldestWait,
                                Math.max(0, (global.Game.virtualTime || Date.now()) -
                                    Number(guest.spawnTime || 0)) / 1000);
                        });
                        score = vip * 10000000 + critical * 100000 +
                            annoyed * 10000 + oldestWait + waiting.length * 100 -
                            Math.abs(floorIndex - current);
                        score /= 10000000;
                    }
                    features.push(Math.max(-1, Math.min(2, score)));
                }
            }
        }
        if (fullControlEnabled()) {
            // Make the control state Markov for the expanded action space.
            // Automation policy and power-up availability are visible to the
            // policy instead of being hidden in the JavaScript realm.
            for (let liftIndex = 0; liftIndex < spaceLifts; liftIndex++) {
                const lift = lifts[liftIndex] || null;
                AUTOMATION_MODES.forEach(function (mode) {
                    features.push(lift && lift.automation === mode ? 1 : 0);
                });
            }
            POWERUP_IDS.forEach(function (id) {
                const tier = powerupTierForInventory(
                    id, Math.trunc(finiteNumber(Registry.stats.round, 1))
                );
                features.push(tier >= 0 ? 1 : 0);
                features.push(powerupActive(id) ? 1 : 0);
            });
        }
        return features;
    }

    function actionMask() {
        const actualFloors = Math.max(1, (Registry.floors || []).length);
        const actualLifts = (Registry.lifts || []).length;
        const spaceFloors = Math.max(1, Math.trunc(finiteNumber(
            global.__liftOperatorSpaceFloors, actualFloors)));
        const spaceLifts = Math.max(1, Math.trunc(finiteNumber(
            global.__liftOperatorSpaceLifts, actualLifts)));
        const factorized = Boolean(global.__liftOperatorFactorizedDispatch);
        const actionCount = fullControlEnabled()
            ? dispatchCount(spaceFloors, spaceLifts, factorized) + 1 +
                spaceLifts * AUTOMATION_MODES.length + POWERUP_IDS.length
            : dispatchCount(spaceFloors, spaceLifts, factorized) + 1;
        const noOp = dispatchCount(
            spaceFloors, spaceLifts, factorized
        );
        const result = new Array(actionCount).fill(0);
        result[noOp] = 1;
        if (factorized) {
            const availableLifts = (Registry.lifts || []).filter(function (lift) {
                const atTarget = Math.abs(Number(lift.pos || 0) -
                    Number(lift.targetFloor || 0) * Registry.floorHeight) < 0.01;
                return atTarget && ['IDLE', 'DONE'].includes(lift.state) &&
                    lift.jamTimer <= 0 && !lift.isJammed;
            });
            for (let floor = 0; floor < actualFloors; floor++) {
                if (availableLifts.some(function (lift) {
                    if (Registry.isFloorInLiftZone &&
                        !Registry.isFloorInLiftZone(lift, floor)) return false;
                    // Keep the mask consistent with the factorized dispatcher
                    // below: a loaded lift can only be redirected to a
                    // passenger destination; an empty lift may be sent to a
                    // new pickup floor.
                    const passengers = lift.passengers || [];
                    return passengers.length === 0 || passengers.some(function (passenger) {
                        return Math.trunc(Number(passenger.dest)) === floor;
                    });
                })) result[floor] = 1;
            }
        } else {
            // The final action is an explicit no-op. Targets outside an
            // active service zone are masked while preserving the production
            // command path for every unmasked target.
            for (let liftId = 0; liftId < actualLifts; liftId++) {
                const lift = Registry.lifts[liftId];
                const atTarget = Math.abs(Number(lift.pos || 0) -
                    Number(lift.targetFloor || 0) * Registry.floorHeight) < 0.01;
                const available = atTarget && ['IDLE', 'DONE'].includes(lift.state) &&
                    lift.jamTimer <= 0 && !lift.isJammed;
                for (let floor = 0; floor < actualFloors; floor++) {
                    if (!available ||
                        (Registry.isFloorInLiftZone && !Registry.isFloorInLiftZone(lift, floor))) {
                        result[liftId * spaceFloors + floor] = 0;
                    } else {
                        result[liftId * spaceFloors + floor] = 1;
                    }
                }
            }
        }
        if (fullControlEnabled()) {
            const automationBase = noOp + 1;
            const round = Math.trunc(finiteNumber(Registry.stats.round, 1));
            for (let liftId = 0; liftId < actualLifts; liftId++) {
                for (let modeIndex = 0; modeIndex < AUTOMATION_MODES.length; modeIndex++) {
                    const mode = AUTOMATION_MODES[modeIndex];
                    const lift = Registry.lifts[liftId];
                    if (automationModeLegal(mode, round) &&
                        lift && lift.automation !== mode) {
                        result[automationBase + liftId * AUTOMATION_MODES.length + modeIndex] = 1;
                    }
                }
            }
            const powerupBase = powerupActionBase(
                spaceFloors, spaceLifts, factorized
            );
            POWERUP_IDS.forEach(function (id, index) {
                // Priming an already-active ability is rejected by the
                // production Supply Closet. Keep the action mask faithful to
                // that legality rule so PPO does not spend probability mass
                // on a command that can only become an ineffective no-op.
                if (powerupTierForInventory(id, round) >= 0 &&
                    !powerupActive(id)) {
                    result[powerupBase + index] = 1;
                }
            });
        }
        return result;
    }

    function desiredAutomation(round, liftIndex) {
        // This is the authored hybrid strategy: manual on the tutorial
        // rounds, then specialized built-ins as the campaign unlocks them.
        // It is a planner prior, not hidden simulator state; every transition
        // below is sent through the same Automation Dock API as a player.
        const modes = {
            1: ['manual'],
            2: ['sweep'],
            3: ['priority-sweep', 'sweep'],
            4: ['priority-sweep', 'sweep'],
            5: ['sweep', 'priority-sweep', 'sweep'],
            6: ['sweep', 'sweep', 'priority-sweep'],
            7: ['priority-sweep'],
            8: ['priority-sweep'],
            9: ['sweep'],
            10: ['priority-sweep'],
            11: ['priority-sweep'],
            12: ['sweep', 'priority-sweep'],
            13: ['priority-sweep', 'sweep'],
            14: ['priority-sweep'],
            15: ['priority-sweep'],
            16: ['priority-sweep'],
            17: ['priority-sweep'],
            18: ['priority-sweep'],
            19: ['priority-sweep'],
            20: ['priority-sweep'],
            21: ['priority-sweep'],
            22: ['priority-sweep'],
            23: ['priority-sweep'],
            24: ['voting'],
            25: ['priority-sweep']
        }[round] || ['manual'];
        return modes[liftIndex % modes.length];
    }

    function plannerAutomationAction(actionCount, spaceFloors, spaceLifts) {
        if (!fullControlEnabled()) return -1;
        const round = Math.trunc(finiteNumber(Registry.stats.round, 1));
        const base = automationActionBase(
            spaceFloors, spaceLifts, global.__liftOperatorFactorizedDispatch
        );
        const lifts = Registry.lifts || [];
        for (let liftIndex = 0; liftIndex < lifts.length; liftIndex++) {
            const lift = lifts[liftIndex];
            const desired = desiredAutomation(round, liftIndex);
            if (lift.automation === desired || !automationModeLegal(desired, round)) continue;
            const modeIndex = AUTOMATION_MODES.indexOf(desired);
            const action = base + liftIndex * AUTOMATION_MODES.length + modeIndex;
            const mask = actionMask();
            if (action >= 0 && action < actionCount && mask[action]) return action;
        }
        return -1;
    }

    function plannerPowerupAction(actionCount, spaceFloors, spaceLifts) {
        if (!fullControlEnabled() || typeof PowerUps === 'undefined') return -1;
        const round = Math.trunc(finiteNumber(Registry.stats.round, 1));
        const base = powerupActionBase(
            spaceFloors, spaceLifts, global.__liftOperatorFactorizedDispatch
        );
        const lifts = Registry.lifts || [];
        const needsWrench = lifts.some(function (lift) {
            return lift.jamTimer > 0 || lift.isJammed;
        });
        const needsFreshener = lifts.some(function (lift) {
            return lift.stinkTimer > 0;
        });
        let criticalCount = 0;
        let annoyedCount = 0;
        let rageCount = 0;
        let vipCount = 0;
        let peakQueue = 0;
        (Registry.floors || []).forEach(function (floor) {
            const waiting = floor.waitingGuests || [];
            peakQueue = Math.max(peakQueue, waiting.length);
            waiting.forEach(function (guest) {
                if (guest.isVip) vipCount++;
                if (guest.status === 'critical') criticalCount++;
                else if (guest.status === 'annoyed') annoyedCount++;
                else if (guest.status === 'rage') rageCount++;
            });
        });
        const overloaded = lifts.some(function (lift) {
            const capacity = (typeof PowerUps.getLiftCapacity === 'function')
                ? PowerUps.getLiftCapacity(lift.id) : 10;
            return (lift.passengers || []).length >= Math.max(1, capacity - 2);
        });
        // Event-aware play spends a resource before the queue has already
        // become fatal.  The authored simulator's intervention controller
        // uses queue pressure, VIPs and hazards as its trigger; mirroring
        // those signals produces a much stronger teacher than waiting only
        // for CRITICAL guests.
        const pressure = vipCount > 0 || criticalCount > 0 || rageCount > 0 ||
            annoyedCount >= 2 || peakQueue >= 5 || overloaded;
        const choices = [];
        if (needsWrench) choices.push('wrench');
        if (needsFreshener) choices.push('freshener');
        if (rageCount > 0 || criticalCount >= 2 || annoyedCount >= 4) {
            choices.push('musak');
        }
        if (peakQueue >= 8 || criticalCount > 0 || vipCount > 0) {
            choices.push('doors');
        }
        if (peakQueue >= 12 || overloaded || (Registry.stats.timeLeft || 0) < 30) {
            choices.push('tardis', 'doubleDecker', 'turbo');
        }
        // A finite loadout is a resource, but holding every charge until the
        // first life loss is also wasteful.  Use one throughput charge at a
        // long, deterministic cadence when the round has sustained pressure.
        const elapsed = Math.trunc(finiteNumber(
            global.__liftOperatorElapsedSeconds, 0
        ));
        const lastPowerup = finiteNumber(
            global.__liftOperatorLastPowerupSecond, -1000000
        );
        const hazard = needsWrench || needsFreshener;
        // Do not repeatedly spend a finite charge while the same queue is
        // visible.  Hazards get a short emergency cooldown; throughput
        // effects are deliberately spaced over a service window.
        const cooldown = hazard ? 2 : 10;
        if (elapsed - lastPowerup < cooldown) {
            global.__liftOperatorPlannerDebug = {
                elapsed: elapsed,
                lastPowerup: lastPowerup,
                cooldown: cooldown,
                inventory: (PowerUps.inventory || []).length,
                choices: [],
                selected: -1,
            };
            return -1;
        }
        // Keep a small proactive cadence even when the visible queue happens
        // to be empty at the decision instant.  Effects such as Turbo and
        // Wide Doors improve the next burst, and the explicit finite loadout
        // bounds this to a handful of charges per round.
        if (elapsed > 0 && elapsed % 15 === 0) {
            choices.push('turbo', 'doors', 'musak');
        }
        global.__liftOperatorPlannerDebug = {
            elapsed: elapsed,
            lastPowerup: lastPowerup,
            cooldown: cooldown,
            inventory: (PowerUps.inventory || []).length,
            choices: choices.slice(),
            selected: -1,
        };
        for (const id of choices) {
            if (powerupTierForInventory(id, round) < 0 || powerupActive(id)) continue;
            const action = base + POWERUP_IDS.indexOf(id);
            const mask = actionMask();
            if (action >= 0 && action < actionCount && mask[action]) {
                global.__liftOperatorPlannerDebug.selected = action;
                return action;
            }
        }
        return -1;
    }

    function scheduledPowerupAction(actionCount, spaceFloors, spaceLifts) {
        if (!fullControlEnabled() || typeof PowerUps === 'undefined') return -1;
        const elapsed = Math.trunc(finiteNumber(
            global.__liftOperatorElapsedSeconds, 0
        ));
        if (elapsed <= 0 || elapsed % 15 !== 0) return -1;
        const round = Math.trunc(finiteNumber(Registry.stats.round, 1));
        const base = powerupActionBase(
            spaceFloors, spaceLifts, global.__liftOperatorFactorizedDispatch
        );
        // Deterministic fallback for quiet rounds: the planner is still
        // issuing the same legal Supply Closet action a player could choose,
        // but does not depend on a queue crossing an arbitrary threshold.
        for (const id of ['turbo', 'doors', 'musak', 'wrench', 'freshener',
            'tardis', 'doubleDecker', 'openPlan', 'groupThink']) {
            if (powerupTierForInventory(id, round) < 0 || powerupActive(id)) continue;
            const action = base + POWERUP_IDS.indexOf(id);
            const mask = actionMask();
            if (action >= 0 && action < actionCount && mask[action]) {
                global.__liftOperatorPlannerDebug = global.__liftOperatorPlannerDebug || {};
                global.__liftOperatorPlannerDebug.selected = action;
                return action;
            }
        }
        return -1;
    }

    function selectPowerupTarget(id) {
        const lifts = Registry.lifts || [];
        let bestLift = 0;
        let bestScore = -Infinity;
        lifts.forEach(function (lift) {
            let score = 0;
            if (id === 'wrench' && (lift.jamTimer > 0 || lift.isJammed)) score += 1e6;
            if (id === 'freshener' && lift.stinkTimer > 0) score += 1e5;
            score += (lift.passengers || []).length * 100;
            if (score > bestScore) {
                bestScore = score;
                bestLift = lift.id;
            }
        });
        let bestFloor = 0;
        let bestFloorScore = -Infinity;
        (Registry.floors || []).forEach(function (floor, index) {
            const guests = floor.waitingGuests || [];
            let score = guests.length;
            guests.forEach(function (guest) {
                if (guest.isVip) score += 1e6;
                if (guest.status === 'critical') score += 1e5;
                else if (guest.status === 'annoyed') score += 1e4;
            });
            if (score > bestFloorScore) {
                bestFloorScore = score;
                bestFloor = index;
            }
        });
        return { lift: bestLift, floor: bestFloor };
    }

    function applyPowerupAction(id, round) {
        const tier = powerupTierForInventory(id, round);
        if (tier < 0 || typeof PowerUps === 'undefined') return false;
        const ability = PowerUps.catalog[id].tiers[tier];
        if (!ability) return false;
        if (ability.target === 'instant') {
            PowerUps.primeAbility(id, tier);
            return true;
        }
        const target = selectPowerupTarget(id);
        PowerUps.primeAbility(id, tier);
        if (PowerUps.activeTargeting) {
            const resolved = PowerUps.resolveTargeting(target.lift, target.floor);
            // Production abilities can reject a target (for example, Wrench
            // on a non-jammed lift). Never leave the real game paused in its
            // targeting modal when that happens.
            if (!resolved && PowerUps.activeTargeting &&
                typeof PowerUps.cancelTargeting === 'function') {
                PowerUps.cancelTargeting();
            }
            // A rejected target is still a consumed control opportunity from
            // the policy's point of view. Keep the action accepted after
            // cancelling the modal so the browser loop can continue ticking.
            return true;
        }
        return true;
    }

    // Apply one action to a live browser realm without advancing its clock.
    // The headless environment below owns its own one-second tick, whereas a
    // real page already has engine-core's setInterval(gameTick, 1000).  Keep
    // the production command path shared, but leave tick scheduling to the
    // browser runner.
    function applyBrowserControlAction(
        action, actionCount, spaceFloors, spaceLifts, factorized, fullControl,
        round
    ) {
        const noOp = dispatchCount(spaceFloors, spaceLifts, factorized);
        const numericAction = Math.trunc(finiteNumber(action, noOp));
        const result = {
            accepted: false,
            action: numericAction,
            kind: 'invalid',
            reason: 'masked'
        };
        const mask = actionMask();
        if (numericAction < 0 || numericAction >= actionCount || !mask[numericAction]) {
            return result;
        }
        if (!global.__liftOperatorControlActions) {
            global.__liftOperatorControlActions = {
                dispatch: 0, automation: 0, powerup: 0, noOp: 0
            };
        }
        const controls = global.__liftOperatorControlActions;
        const automationBase = noOp + 1;
        const powerupBase = powerupActionBase(
            spaceFloors, spaceLifts, factorized
        );
        if (fullControl && numericAction >= automationBase &&
            numericAction < powerupBase) {
            const encoded = numericAction - automationBase;
            const liftId = Math.floor(encoded / AUTOMATION_MODES.length);
            const modeIndex = encoded % AUTOMATION_MODES.length;
            const mode = AUTOMATION_MODES[modeIndex];
            if (liftId >= (Registry.lifts || []).length ||
                !automationModeLegal(mode, round)) {
                result.reason = 'unavailable';
                return result;
            }
            try {
                global.setLiftAutomation(liftId, mode);
                controls.automation++;
                result.accepted = true;
                result.kind = 'automation';
                result.reason = '';
            } catch (error) {
                result.reason = String(error && error.message ? error.message : error);
            }
            return result;
        }
        if (fullControl && numericAction >= powerupBase &&
            numericAction < powerupBase + POWERUP_IDS.length) {
            const powerupId = POWERUP_IDS[numericAction - powerupBase];
            if (powerupTierForInventory(powerupId, round) < 0 ||
                powerupActive(powerupId)) {
                result.reason = 'unavailable';
                return result;
            }
            if (applyPowerupAction(powerupId, round)) {
                controls.powerup++;
                global.__liftOperatorBrowserLastPowerupAt = Date.now();
                result.accepted = true;
                result.kind = 'powerup';
                result.reason = '';
            }
            return result;
        }
        if (numericAction === noOp) {
            controls.noOp++;
            result.accepted = true;
            result.kind = 'no-op';
            result.reason = '';
            return result;
        }
        if (factorized) {
            if (numericAction < 0 || numericAction >= spaceFloors) {
                return result;
            }
            const targetFloor = numericAction;
            const available = (Registry.lifts || []).filter(function (lift) {
                const atTarget = Math.abs(Number(lift.pos || 0) -
                    Number(lift.targetFloor || 0) * Registry.floorHeight) < 0.01;
                return atTarget && ['IDLE', 'DONE'].includes(lift.state) &&
                    lift.jamTimer <= 0 && !lift.isJammed &&
                    (!Registry.isFloorInLiftZone ||
                        Registry.isFloorInLiftZone(lift, targetFloor));
            });
            let selected = null;
            for (const lift of available) {
                if ((lift.passengers || []).some(function (passenger) {
                    return Math.trunc(Number(passenger.dest)) === targetFloor;
                })) {
                    selected = lift;
                    break;
                }
            }
            if (!selected) {
                let bestScore = -Infinity;
                for (const lift of available) {
                    if ((lift.passengers || []).length) continue;
                    const queue = (Registry.floors || [])[targetFloor];
                    const guests = queue ? (queue.waitingGuests || []) : [];
                    let vip = 0;
                    let critical = 0;
                    let annoyed = 0;
                    let oldestWait = 0;
                    guests.forEach(function (guest) {
                        if (guest.isVip) vip++;
                        if (guest.status === GuestStatus.CRITICAL) critical++;
                        else if (guest.status === GuestStatus.ANNOYED) annoyed++;
                        oldestWait = Math.max(oldestWait,
                            Math.max(0, (global.Game.virtualTime || Date.now()) -
                                Number(guest.spawnTime || 0)));
                    });
                    const current = Math.round(Number(lift.pos || 0) /
                        Registry.floorHeight);
                    const score = vip * 10000000 + critical * 100000 +
                        annoyed * 10000 + oldestWait + guests.length * 100 -
                        Math.abs(targetFloor - current);
                    if (score > bestScore ||
                        (score === bestScore && (!selected || lift.id < selected.id))) {
                        bestScore = score;
                        selected = lift;
                    }
                }
            }
            if (selected) {
                global.setLiftTarget(selected.id, targetFloor);
                controls.dispatch++;
                result.accepted = true;
                result.kind = 'dispatch';
                result.reason = '';
            }
            return result;
        }
        if (numericAction >= 0 && numericAction < spaceLifts * spaceFloors) {
            const liftId = Math.floor(numericAction / spaceFloors);
            const targetFloor = numericAction % spaceFloors;
            if (liftId < (Registry.lifts || []).length &&
                targetFloor < (Registry.floors || []).length) {
                global.setLiftTarget(liftId, targetFloor);
                controls.dispatch++;
                result.accepted = true;
                result.kind = 'dispatch';
                result.reason = '';
            }
        }
        return result;
    }

    function heuristicAction(actionCount) {
        const floors = Math.max(1, Number(Config.numFloors) || 1);
        const spaceFloors = Math.max(1, Math.trunc(finiteNumber(
            global.__liftOperatorSpaceFloors, floors)));
        const lifts = Registry.lifts || [];
        const available = lifts.filter(function (lift) {
            const atTarget = Math.abs(Number(lift.pos || 0) -
                Number(lift.targetFloor || 0) * Registry.floorHeight) < 0.01;
            return atTarget && ['IDLE', 'DONE'].includes(lift.state) &&
                lift.jamTimer <= 0 && !lift.isJammed;
        });
        const factorized = Boolean(global.__liftOperatorFactorizedDispatch);
        const actionSpaceLifts = Math.max(1, Math.trunc(finiteNumber(
            global.__liftOperatorSpaceLifts, lifts.length
        )));
        const noOp = dispatchCount(spaceFloors, actionSpaceLifts, factorized);
        if (fullControlEnabled()) {
            const powerupAction = plannerPowerupAction(
                actionCount, spaceFloors, actionSpaceLifts
            );
            if (powerupAction >= 0) return powerupAction;
            const scheduledAction = scheduledPowerupAction(
                actionCount, spaceFloors, actionSpaceLifts
            );
            if (scheduledAction >= 0) return scheduledAction;
            const automationAction = plannerAutomationAction(
                actionCount, spaceFloors, actionSpaceLifts
            );
            if (automationAction >= 0) return automationAction;
        }
        if (!available.length) return noOp;

        // Passenger destinations have priority over new pickups.  This is the
        // same operational rule used by the upstream simulator's
        // idealized-dispatch strategy, but emits one discrete Gym action. When
        // several passengers share a destination, serve that group together
        // to avoid spending a full travel cycle on each individual guest.
        for (const lift of available) {
            if (!lift.passengers || !lift.passengers.length) continue;
            // Built-in automation is part of the authored clean game. A
            // manual command temporarily overrides its circuit, so do not
            // re-dispatch every routine passenger. Intervene only for an
            // urgent passenger (or on a genuinely manual lift); ordinary
            // traffic remains with Sweep / Priority Sweep.
            const automated = lift.automation && lift.automation !== 'manual';
            const urgentPassenger = lift.passengers.some(function (passenger) {
                return passenger.isVip || passenger.status === 'critical' ||
                    passenger.status === 'annoyed' || passenger.status === 'rage';
            });
            if (automated && !urgentPassenger) continue;
            const current = Math.round(Number(lift.pos || 0) / Registry.floorHeight);
            let destination = current;
            let bestScore = -1;
            for (let floor = 0; floor < floors; floor++) {
                let count = 0;
                let critical = 0;
                let annoyed = 0;
                let oldestWait = 0;
                lift.passengers.forEach(function (passenger) {
                    if (Math.trunc(Number(passenger.dest)) !== floor) return;
                    count++;
                    if (passenger.status === 'critical') critical++;
                    else if (passenger.status === 'annoyed') annoyed++;
                    oldestWait = Math.max(oldestWait,
                        Math.max(0, (global.Game.virtualTime || Date.now()) -
                            Number(passenger.spawnTime || 0)));
                });
                if (!count) continue;
                const score = count * 100000 + critical * 10000 +
                    annoyed * 1000 + oldestWait - Math.abs(floor - current);
                if (score > bestScore) {
                    bestScore = score;
                    destination = floor;
                }
            }
            return factorized ? destination : lift.id * spaceFloors + destination;
        }

        let best = null;
        lifts.forEach(function (lift) {
            if (!available.includes(lift) || (lift.passengers && lift.passengers.length)) return;
            const current = Math.round(Number(lift.pos || 0) / Registry.floorHeight);
            (Registry.floors || []).forEach(function (floor, floorIndex) {
                const guests = floor.waitingGuests || [];
                if (!guests.length) return;
                const automated = lift.automation && lift.automation !== 'manual';
                if (automated && !guests.some(function (guest) {
                    return guest.isVip || guest.status === 'critical' ||
                        guest.status === 'annoyed' || guest.status === 'rage';
                })) return;
                let critical = 0;
                let annoyed = 0;
                let vip = 0;
                let oldestWait = 0;
                guests.forEach(function (guest) {
                    if (guest.status === 'critical') critical++;
                    else if (guest.status === 'annoyed') annoyed++;
                    if (guest.isVip) vip++;
                    oldestWait = Math.max(oldestWait,
                        Math.max(0, (global.Game.virtualTime || Date.now()) - Number(guest.spawnTime || 0)));
                });
                // Match the upstream idealized-dispatch comparator: waiting
                // time dominates queue size, and each additional guest adds
                // 100 points.
                const score = vip * 10000000 + critical * 100000 + annoyed * 10000 +
                    oldestWait + guests.length * 100 - Math.abs(floorIndex - current);
                if (!best || score > best.score ||
                    (score === best.score && floorIndex < best.floorIndex) ||
                    (score === best.score && floorIndex === best.floorIndex && lift.id < best.lift.id)) {
                    best = { lift: lift, floorIndex: floorIndex, score: score };
                }
            });
        });
        return best
            ? (factorized ? best.floorIndex : best.lift.id * spaceFloors + best.floorIndex)
            : noOp;
    }

    function snapshot() {
        return {
            engine: 'upstream-lift-operator',
            simulatorLoaded: Boolean(global.Game.Simulator && global.Game.Simulator.runRoundLocal),
            round: Registry.stats.round,
            seed: Registry.seed,
            timeLeft: Registry.stats.timeLeft,
            lives: Registry.stats.lives,
            served: Registry.roundStats.servedThisRound,
            guestsSpawned: Registry.roundStats.guestsSpawned,
            defenestrations: Registry.roundStats.defenestrationsThisRound,
            finalScore: global.__liftOperatorFinalScore,
            success: Registry.stats.lives > 0,
            gameActive: Boolean(Registry.gameActive),
            objective: (Config.GAME_DATA.rounds[Registry.stats.round] || {}).objective,
            automationProfile: global.__liftOperatorAutomationProfile || 'upstream',
            floors: (Registry.floors || []).map(function (floor) {
                return (floor.waitingGuests || []).map(function (guest) {
                    return { id: guest.id, dest: guest.dest, status: guest.status, vip: Boolean(guest.isVip) };
                });
            }),
            lifts: (Registry.lifts || []).map(function (lift) {
                return {
                    id: lift.id,
                    pos: lift.pos,
                    targetFloor: lift.targetFloor,
                    automation: lift.automation,
                    state: lift.state,
                    jamTimer: lift.jamTimer,
                    passengers: (lift.passengers || []).map(function (guest) {
                        return { id: guest.id, dest: guest.dest, status: guest.status, vip: Boolean(guest.isVip) };
                    })
                };
            }),
            roundStats: Registry.roundStats
        };
    }

    function metrics() {
        return {
            engine: 'upstream-lift-operator',
            round: Registry.stats.round,
            seed: Registry.seed,
            timeLeft: Registry.stats.timeLeft,
            lives: Registry.stats.lives,
            served: Registry.roundStats.servedThisRound,
            guestsSpawned: Registry.roundStats.guestsSpawned,
            defenestrations: Registry.roundStats.defenestrationsThisRound,
            finalScore: global.__liftOperatorFinalScore,
            success: Registry.stats.lives > 0,
            gameActive: Boolean(Registry.gameActive),
            objective: (Config.GAME_DATA.rounds[Registry.stats.round] || {}).objective,
            automationProfile: global.__liftOperatorAutomationProfile || 'upstream',
            autoPowerups: Boolean(global.__liftOperatorAutoPowerups),
            inventoryCount: typeof PowerUps !== 'undefined'
                ? (PowerUps.inventory || []).length : 0,
            controlActions: global.__liftOperatorControlActions || {
                dispatch: 0, automation: 0, powerup: 0, noOp: 0
            },
            planner: global.__liftOperatorPlannerDebug || {},
        };
    }

    function resetRuntime(seed, round, options) {
        const virtualStart = 1000000;
        global.Game.UI = makeNoopUi();
        global.Game.Audio = makeNoopAudio();
        global.Game.virtualTime = virtualStart;
        // The browser boot path calls Automation.init() from
        // initializeEngine().  The headless adapter intentionally invokes
        // initializeRound() directly, so initialize the VM here as part of
        // the environment boundary.  Without this, later authored rounds
        // still carry an automation label (for example ``sweep``), but the
        // VM has no system scripts and those lifts remain parked forever.
        if (global.Game.Automation &&
            typeof global.Game.Automation.init === 'function') {
            global.Game.Automation.init();
        }
        Registry.autoPilotActive = false;
        Registry.manualIntervention = false;
        Registry.useCampaignSeeds = false;
        Registry.seed = seed;
        if (options && options.roundOverrides) {
            const existing = Config.GAME_DATA.rounds[round] || {};
            Config.GAME_DATA.rounds[round] = Object.assign({}, existing, options.roundOverrides);
        }
        const initOptions = {
            now: virtualStart,
            showBriefing: false,
            seedOverride: seed
        };
        // An explicit space override is represented as an upstream operation
        // definition, preserving all round defaults (objective, spawn curve,
        // challenges, and physics) while changing only the requested shape.
        if (options && (options.operation || options.floors !== undefined || options.lifts !== undefined)) {
            const base = Config.GAME_DATA.rounds[round] || {};
            initOptions.operation = Object.assign({}, base, options.operation || {}, {
                round: round,
                floors: Math.max(1, Math.trunc(finiteNumber(options.floors, base.floors))),
                lifts: Math.max(1, Math.trunc(finiteNumber(options.lifts, base.lifts)))
            });
        }
        global.initializeRound(round, initOptions);
        // ``initializeRound`` clears the attempt inventory as the browser
        // does.  Reapply an explicitly declared episode loadout afterwards so
        // headless training/evaluation can model the Supply Closet without
        // mutating the vendored game rules.
        if (options && Array.isArray(options.loadout) &&
            typeof PowerUps !== 'undefined') {
            PowerUps.inventory = options.loadout.map(function (item) {
                return { id: item.id, tier: item.tier };
            });
        }
        // Training can opt into a deterministic, round-aware automation
        // profile.  This models the authored game loop (policy selection is a
        // strategic action) while keeping the ordinary adapter's production
        // defaults untouched.  Rounds 24/25 deliberately use the capsule
        // controller's high-throughput policy; counterweight rounds retain a
        // single policy per pair through setLiftAutomation().
        if (options && options.automationProfile === 'campaign') {
            const roundModes = {
                1: ['sweep'],
                2: ['sweep'],
                3: ['priority-sweep', 'sweep'],
                4: ['priority-sweep', 'sweep'],
                5: ['sweep', 'priority-sweep', 'sweep'],
                6: ['sweep', 'sweep', 'priority-sweep'],
                7: ['priority-sweep'],
                8: ['priority-sweep'],
                9: ['sweep'],
                10: ['priority-sweep'],
                11: ['priority-sweep'],
                12: ['sweep', 'priority-sweep'],
                13: ['priority-sweep', 'sweep'],
                14: ['priority-sweep'],
                15: ['priority-sweep'],
                16: ['priority-sweep'],
                17: ['priority-sweep'],
                18: ['priority-sweep'],
                19: ['priority-sweep'],
                20: ['priority-sweep'],
                21: ['priority-sweep'],
                22: ['priority-sweep'],
                23: ['priority-sweep'],
                24: ['voting'],
                25: ['priority-sweep']
            }[round];
            if (Array.isArray(roundModes)) {
                for (let index = 0; index < Registry.lifts.length; index++) {
                    const mode = roundModes[index % roundModes.length];
                    if (typeof global.setLiftAutomation === 'function') {
                        global.setLiftAutomation(index, mode);
                    }
                }
            }
        }
        // ``clean`` keeps the authored upstream automation (for example the
        // normal Sweep driver unlocked by later rounds). That is a legal game
        // mechanic, not an injected teacher. ``manual``/``pure`` is a
        // stricter policy-only mode with no automatic lift driver.
        if (options && (options.automationProfile === 'manual' ||
            options.automationProfile === 'pure')) {
            for (let index = 0; index < Registry.lifts.length; index++) {
                if (typeof global.setLiftAutomation === 'function') {
                    global.setLiftAutomation(index, 'manual');
                }
            }
        }
        // A stocked headless campaign is useful for training a dispatch
        // policy because the public action space currently represents target
        // commands, not the UI's separate power-up targeting gesture.  The
        // budget is explicit and finite; production callers get no inventory
        // unless they request it.  Tier-2 effects are instant/global and are
        // therefore safe to schedule without synthesizing a lift target.
        const budget = options && Number.isFinite(Number(options.powerupBudget))
            ? Math.max(0, Math.trunc(Number(options.powerupBudget)))
            : 0;
        if (budget > 0 && typeof PowerUps !== 'undefined') {
            const ids = [
                'doors', 'turbo', 'musak', 'wrench', 'freshener',
                'tardis', 'doubleDecker', 'openPlan', 'groupThink'
            ];
            const loadout = [];
            ids.forEach(function (id) {
                for (let count = 0; count < budget; count++) {
                    loadout.push({ id: id, tier: 2 });
                }
            });
            PowerUps.inventory = loadout;
        }
        Registry.gameActive = true;
        return virtualStart;
    }

    global.createLiftOperatorUpstreamEnv = function (options) {
        options = options || {};
        // snapshot() is a shared helper outside this factory. Keep these
        // diagnostics in the same single-game global namespace as Registry.
        global.__liftOperatorAutomationProfile = options.automationProfile || 'upstream';
        global.__liftOperatorAutoPowerups = Boolean(options.autoPowerups);
        global.__liftOperatorTelemetryEnabled = options.telemetry !== false;
        if (!global.__liftOperatorTelemetryEnabled &&
            global.Game.BalanceTelemetry) {
            // BalanceTelemetry is a reporting layer only. It performs a
            // full guest traversal and journey-time sort every gameTick but
            // does not feed any game decision. Keep recordSpawn/recordLifeLoss
            // intact because those update round statistics used by rewards.
            global.Game.BalanceTelemetry.sample = function () { return null; };
        }
        let round = Math.max(1, Math.min(25, Math.trunc(finiteNumber(options.round, 1))));
        const floors = Math.max(1, Math.trunc(finiteNumber(options.floors, Config.GAME_DATA.rounds[round].floors)));
        const lifts = Math.max(1, Math.trunc(finiteNumber(options.lifts, Config.GAME_DATA.rounds[round].lifts)));
        const spaceFloors = Math.max(floors, Math.trunc(finiteNumber(options.spaceFloors, floors)));
        const spaceLifts = Math.max(lifts, Math.trunc(finiteNumber(options.spaceLifts, lifts)));
        const factorizedDispatch = Boolean(options.factorizedDispatch);
        const baseActionCount = factorizedDispatch
            ? spaceFloors + 1
            : spaceLifts * spaceFloors + 1;
        const fullControl = options.controlMode === 'full' ||
            Boolean(options.fullControl);
        const dispatchActions = dispatchCount(
            spaceFloors, spaceLifts, factorizedDispatch
        ) + 1;
        const fullActionCount = fullControl
            ? dispatchActions + spaceLifts * AUTOMATION_MODES.length + POWERUP_IDS.length
            : baseActionCount;
        const actionCount = fullActionCount;
        // These function references are stable for the lifetime of the
        // JavaScriptCore realm. Avoid a global property lookup for every one
        // of the 60 animation frames in an environment step.
        const simulationGameTick = global.gameTick;
        const simulationAnimationTick = global.animationTick;
        let seed = 1;
        let virtualTime = 1000000;
        let elapsedSeconds = 0; let framePhase = 0;
        let terminated = false;
        let truncated = false;
        // The browser displays this after round review. Keep a terminal copy
        // for headless callers without mutating Registry.points.
        let finalScore = null;
        const autoPowerups = Boolean(options.autoPowerups);
        const powerupInterval = Math.max(1, Math.trunc(finiteNumber(
            options.powerupIntervalSec, 5)));
        global.__liftOperatorFinalScore = null;
        const richObservation = Boolean(options.richObservation);
        const includeRound = Boolean(options.includeRound);
        global.__liftOperatorSpaceFloors = spaceFloors;
        global.__liftOperatorSpaceLifts = spaceLifts;
        global.__liftOperatorFactorizedDispatch = factorizedDispatch;
        global.__liftOperatorRichObservation = richObservation;
        global.__liftOperatorIncludeRound = includeRound;
        global.__liftOperatorDispatchFeatures = Boolean(options.dispatchFeatures);
        global.__liftOperatorFullControl = fullControl;
        const observationSize = (includeRound ? 27 : 0) +
            4 + spaceFloors * (6 + (richObservation ? 1 : 0)) +
            (richObservation ? spaceFloors : 0) +
            spaceLifts * (8 + (richObservation ? spaceFloors * 2 + 1 : 0)) +
            (Boolean(options.dispatchFeatures) ? spaceLifts * spaceFloors : 0) +
            (fullControl
                ? spaceLifts * AUTOMATION_MODES.length + POWERUP_IDS.length * 2
                : 0);

        function reset(nextSeed) {
            seed = finiteNumber(nextSeed, 1);
            virtualTime = resetRuntime(seed, round, options);
            elapsedSeconds = 0; framePhase = 0;
            global.__liftOperatorElapsedSeconds = 0;
            global.__liftOperatorLastPowerupSecond = -1000000;
            global.__liftOperatorControlActions = {
                dispatch: 0, automation: 0, powerup: 0, noOp: 0
            };
            terminated = false;
            truncated = false;
            finalScore = null;
            global.__liftOperatorFinalScore = null;
            return observation();
        }

        function setRound(nextRound) {
            round = Math.max(1, Math.min(25, Math.trunc(finiteNumber(nextRound, round))));
            return reset(seed);
        }

        function schedulePowerup() {
            if (!autoPowerups || typeof PowerUps === 'undefined' ||
                elapsedSeconds % powerupInterval !== 0) return;
            // Prefer throughput/time effects, but repair only when a jam is
            // actually visible.  Do not repeatedly prime an already-active
            // global effect; this keeps the finite budget meaningful.
            for (const item of PowerUps.inventory || []) {
                const ability = PowerUps.catalog[item.id] &&
                    PowerUps.catalog[item.id].tiers[item.tier];
                if (!ability || ability.target !== 'instant' ||
                    !PowerUps.isPowerUpAvailableForRound(item.id, round)) continue;
                if (item.id === 'wrench') {
                    if (!(Registry.lifts || []).some(function (lift) {
                        return lift.jamTimer > 0 || lift.isJammed;
                    })) continue;
                } else if (PowerUps.isGlobalPowerUpActive(item.id)) {
                    continue;
                }
                try {
                    PowerUps.primeAbility(item.id, item.tier);
                } catch (error) {
                    // Keep the environment step boundary diagnostic rather
                    // than letting a browser-only UI hook abort JavaScriptCore.
                    global.__liftOperatorPowerupError = String(
                        error && error.message ? error.message : error
                    );
                }
                break;
            }
        }

        function step(action) {
            if (terminated || truncated) {
                return { reward: 0, terminated: terminated, truncated: truncated };
            }
            const noOp = dispatchCount(
                spaceFloors, spaceLifts, factorizedDispatch
            );
            const numericAction = Math.trunc(finiteNumber(action, noOp));
            if (framePhase === 0) schedulePowerup();
            const automationBase = noOp + 1;
            const powerupBase = powerupActionBase(
                spaceFloors, spaceLifts, factorizedDispatch
            );
            const controls = global.__liftOperatorControlActions;
            if (fullControl && numericAction >= automationBase &&
                numericAction < powerupBase) {
                if (controls) controls.automation++;
                const encoded = numericAction - automationBase;
                const liftId = Math.floor(encoded / AUTOMATION_MODES.length);
                const modeIndex = encoded % AUTOMATION_MODES.length;
                const mode = AUTOMATION_MODES[modeIndex];
                if (liftId < (Registry.lifts || []).length &&
                    automationModeLegal(mode, round)) {
                    try {
                        global.setLiftAutomation(liftId, mode);
                    } catch (error) {
                        global.__liftOperatorControlError = String(
                            error && error.message ? error.message : error
                        );
                    }
                }
            } else if (fullControl && numericAction >= powerupBase &&
                numericAction < powerupBase + POWERUP_IDS.length) {
                if (controls) controls.powerup++;
                const powerupId = POWERUP_IDS[numericAction - powerupBase];
                if (applyPowerupAction(powerupId, round)) {
                    global.__liftOperatorLastPowerupSecond = elapsedSeconds;
                }
            } else if (factorizedDispatch) {
                if (controls) {
                    if (numericAction === noOp) controls.noOp++;
                    else controls.dispatch++;
                }
                if (numericAction >= 0 && numericAction < spaceFloors) {
                    const targetFloor = numericAction;
                    const available = (Registry.lifts || []).filter(function (lift) {
                        const atTarget = Math.abs(Number(lift.pos || 0) -
                            Number(lift.targetFloor || 0) * Registry.floorHeight) < 0.01;
                        return atTarget && ['IDLE', 'DONE'].includes(lift.state) &&
                            lift.jamTimer <= 0 && !lift.isJammed &&
                            (!Registry.isFloorInLiftZone ||
                                Registry.isFloorInLiftZone(lift, targetFloor));
                    });
                    // Preserve the upstream teacher's operational priority:
                    // a parked lift carrying passengers gets the destination
                    // first; otherwise choose the nearest empty parked lift.
                    let selected = null;
                    for (const lift of available) {
                        if ((lift.passengers || []).some(function (passenger) {
                            return Math.trunc(Number(passenger.dest)) === targetFloor;
                        })) {
                            selected = lift;
                            break;
                        }
                    }
                    if (!selected) {
                        let bestScore = -Infinity;
                        for (const lift of available) {
                            if ((lift.passengers || []).length) continue;
                            const queue = (Registry.floors || [])[targetFloor];
                            const guests = queue ? (queue.waitingGuests || []) : [];
                            let vip = 0;
                            let critical = 0;
                            let annoyed = 0;
                            let oldestWait = 0;
                            guests.forEach(function (guest) {
                                if (guest.isVip) vip++;
                                if (guest.status === GuestStatus.CRITICAL) critical++;
                                else if (guest.status === GuestStatus.ANNOYED) annoyed++;
                                oldestWait = Math.max(oldestWait,
                                    Math.max(0, (global.Game.virtualTime || Date.now()) -
                                        Number(guest.spawnTime || 0)));
                            });
                            const current = Math.round(Number(lift.pos || 0) /
                                Registry.floorHeight);
                            const score = vip * 10000000 + critical * 100000 +
                                annoyed * 10000 + oldestWait + guests.length * 100 -
                                Math.abs(targetFloor - current);
                            if (score > bestScore ||
                                (score === bestScore && (!selected || lift.id < selected.id))) {
                                bestScore = score;
                                selected = lift;
                            }
                        }
                    }
                    if (selected) global.setLiftTarget(selected.id, targetFloor);
                }
            } else if (numericAction >= 0 && numericAction < spaceLifts * spaceFloors) {
                if (controls) controls.dispatch++;
                const liftId = Math.floor(numericAction / spaceFloors);
                const targetFloor = numericAction % spaceFloors;
                // Fixed-size all-round policies share one action space across
                // rounds.  Actions in the padded portion are invalid for the
                // current round; treat them as no-ops, but still advance the
                // simulator so a bad/unmasked policy cannot stall forever.
                if (liftId < (Registry.lifts || []).length &&
                    targetFloor < (Registry.floors || []).length) {
                    global.setLiftTarget(liftId, targetFloor);
                }
            } else if (controls) {
                controls.noOp++;
            }
            const beforeServed = Registry.roundStats.servedThisRound;
            const beforeLives = Registry.stats.lives;
            if (framePhase === 0) {
                virtualTime += 1000;
                global.Game.virtualTime = virtualTime;
                simulationGameTick(virtualTime);
                elapsedSeconds++;
            }
            for (let frame = 0; frame < 15; frame++) {
                // animationTick intentionally uses Game.virtualTime for all
                // gameplay timestamps; its timestamp parameter is a browser
                // render hint and is unused by the upstream physics path.
                simulationAnimationTick(virtualTime);
            }
            framePhase = (framePhase + 15) % 60;
            global.__liftOperatorElapsedSeconds = elapsedSeconds;
            const servedDelta = Registry.roundStats.servedThisRound - beforeServed;
            const lifeDelta = Registry.stats.lives - beforeLives;
            // Reward is tied to the original game's objective signals, not to
            // the surrogate environment's shaping constants.
            let reward = servedDelta * 1 + lifeDelta * 2;
            const objective = (Config.GAME_DATA.rounds[round] || {}).objective;
            const quota = finiteNumber((Config.GAME_DATA.rounds[round] || {}).quota, Infinity);
            if (objective === 'QUOTA' && Registry.roundStats.servedThisRound >= quota) {
                reward += 10;
            }
            if (Registry.stats.lives <= 0) reward -= 10;
            const maxSeconds = finiteNumber(options.maxSeconds,
                objective === 'ENDURANCE' ? 1800 : Config.roundTime);
            const timerDone = objective !== 'ENDURANCE' && Registry.stats.timeLeft <= 0;
            if (timerDone) Registry.gameActive = false;
            const quotaDone = objective === 'QUOTA' &&
                Registry.roundStats.servedThisRound >= quota;
            terminated = !Registry.gameActive || Registry.stats.lives <= 0 ||
                timerDone || quotaDone;
            truncated = !terminated && elapsedSeconds >= maxSeconds && framePhase === 0;
            if (truncated) Registry.gameActive = false;
            if (terminated || truncated) {
                // Death is a failed attempt in the production game and earns
                // no credits. For a completed round, use the upstream payout
                // calculator without calling evaluateRoundPayout(), which
                // mutates the campaign ledger.
                const completed = timerDone || quotaDone;
                finalScore = completed && Registry.stats.lives > 0 &&
                    typeof PowerUps !== 'undefined' &&
                    typeof PowerUps.calculateRoundPoints === 'function'
                    ? PowerUps.calculateRoundPoints()
                    : 0;
                global.__liftOperatorFinalScore = finalScore;
            }
            return { reward: reward, terminated: terminated, truncated: truncated };
        }

        reset(options.seed);
        return {
            observationSize: observationSize,
            actionCount: fullActionCount,
            reset: reset,
            setRound: setRound,
            step: step,
            observe: observation,
            actionMask: actionMask,
            heuristicAction: function () { return heuristicAction(actionCount); },
            metrics: metrics,
            snapshot: snapshot
        };
    };

    // Browser counterpart to createLiftOperatorUpstreamEnv.  It deliberately
    // does not initialize or tick the game: the real page owns campaign
    // restore, timers, rendering, and user-visible lifecycle state.  A
    // Playwright (or another same-origin host) can inject this file and call
    // the returned methods once a round is active.
    global.createLiftOperatorBrowserControl = function (options) {
        options = options || {};
        if (typeof Registry === 'undefined' || typeof Config === 'undefined') {
            throw new Error('Lift Operator browser control requires the game page');
        }
        const actualFloors = Math.max(1, (Registry.floors || []).length);
        const actualLifts = (Registry.lifts || []).length;
        const spaceFloors = Math.max(actualFloors, Math.trunc(finiteNumber(
            options.spaceFloors, 30
        )));
        const spaceLifts = Math.max(actualLifts, Math.trunc(finiteNumber(
            options.spaceLifts, 20
        )));
        const factorizedDispatch = options.factorizedDispatch !== false;
        const fullControl = options.controlMode !== 'dispatch' &&
            options.fullControl !== false;
        const richObservation = options.richObservation !== false;
        const includeRound = options.includeRound !== false;
        const dispatchFeatures = Boolean(options.dispatchFeatures);
        const dispatchNoOp = dispatchCount(
            spaceFloors, spaceLifts, factorizedDispatch
        );
        const dispatchActions = dispatchNoOp + 1;
        const actionCount = fullControl
            ? dispatchActions + spaceLifts * AUTOMATION_MODES.length + POWERUP_IDS.length
            : dispatchActions;
        const observationSize = (includeRound ? 27 : 0) +
            4 + spaceFloors * (6 + (richObservation ? 1 : 0)) +
            (richObservation ? spaceFloors : 0) +
            spaceLifts * (8 + (richObservation ? spaceFloors * 2 + 1 : 0)) +
            (dispatchFeatures ? spaceLifts * spaceFloors : 0) +
            (fullControl
                ? spaceLifts * AUTOMATION_MODES.length + POWERUP_IDS.length * 2
                : 0);

        global.__liftOperatorSpaceFloors = spaceFloors;
        global.__liftOperatorSpaceLifts = spaceLifts;
        global.__liftOperatorFactorizedDispatch = factorizedDispatch;
        global.__liftOperatorRichObservation = richObservation;
        global.__liftOperatorIncludeRound = includeRound;
        global.__liftOperatorDispatchFeatures = dispatchFeatures;
        global.__liftOperatorFullControl = fullControl;
        if (!global.__liftOperatorControlActions) {
            global.__liftOperatorControlActions = {
                dispatch: 0, automation: 0, powerup: 0, noOp: 0
            };
        }

        function status() {
            const stats = Registry.stats || {};
            const roundStats = Registry.roundStats || {};
            const inventory = typeof PowerUps !== 'undefined'
                ? (PowerUps.inventory || []).map(function (item) {
                    return { id: item.id, tier: Math.trunc(Number(item.tier)) };
                }) : [];
            return {
                round: Math.trunc(finiteNumber(stats.round, 1)),
                timeLeft: finiteNumber(stats.timeLeft, 0),
                lives: finiteNumber(stats.lives, 0),
                served: finiteNumber(roundStats.servedThisRound, 0),
                guestsSpawned: finiteNumber(roundStats.guestsSpawned, 0),
                defenestrations: finiteNumber(
                    roundStats.defenestrationsThisRound, 0
                ),
                gameActive: Boolean(Registry.gameActive),
                terminal: !Registry.gameActive || stats.lives <= 0,
                success: !Registry.gameActive && stats.lives > 0,
                score: finiteNumber(Registry.points, 0),
                inventory: inventory,
                inventoryCount: inventory.length,
                controlActions: global.__liftOperatorControlActions || {
                    dispatch: 0, automation: 0, powerup: 0, noOp: 0
                }
            };
        }

        function tickKey() {
            const stats = Registry.stats || {};
            // Only include state that the upstream one-second gameTick owns.
            // servedThisRound and guestsSpawned can change from animationTick
            // while a lift is boarding, which would let a browser controller
            // submit several actions inside one physics tick.
            return [
                stats.round,
                stats.timeLeft,
                Registry.enduranceSeconds || 0,
                stats.lives,
                Registry.gameActive ? 1 : 0
            ].join(':');
        }

        return {
            schemaVersion: 1,
            observationSize: observationSize,
            actionCount: actionCount,
            dispatchNoOp: dispatchNoOp,
            automationModes: AUTOMATION_MODES.slice(),
            powerupIds: POWERUP_IDS.slice(),
            observe: observation,
            actionMask: actionMask,
            act: function (action) {
                const round = Math.trunc(finiteNumber(
                    Registry.stats && Registry.stats.round, 1
                ));
                return applyBrowserControlAction(
                    action, actionCount, spaceFloors, spaceLifts,
                    factorizedDispatch, fullControl, round
                );
            },
            heuristicAction: function () {
                return heuristicAction(actionCount);
            },
            status: status,
            tickKey: tickKey
        };
    };
})(globalThis);
