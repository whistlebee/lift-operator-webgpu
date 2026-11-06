'use strict';
// Action adapter only: all purchases, effects, timers, and payouts execute
// the vendored browser functions. No GPU implementation is imported here.
const IDS = ['wrench', 'freshener', 'musak', 'turbo', 'doors', 'tardis', 'doubleDecker', 'openPlan', 'groupThink'];
const TIMER = {freshener:'freshenerTimer', musak:'musakTimer', turbo:'turboTimer', doors:'wideDoorsTimer', tardis:'tardisTimer', doubleDecker:'doubleDeckerTimer', openPlan:'openPlanTimer'};
function withShop(context, env, options, vendorRoot) {
    // Presentation is inert; checkoutCart and its accounting are unmodified.
    context.renderShop = () => {};
    context.updateInventoryUI = () => {};
    const R=Registry,P=PowerUps,C=Config;
    const sf = Math.max(R.floors.length, options.spaceFloors || options.floors || 0);
    const sl = Math.max(R.lifts.length, options.spaceLifts || options.lifts || 0);
    const noop = sf * sl, purchase = env.actionCount, start = purchase + 27;
    const limit = options.wideDoorsPurchaseLimit ?? -1;
    const activations = [];
    IDS.forEach((id, family) => P.catalog[id].tiers.forEach((ability, tier) => {
        const count = ability.target === 'instant' ? 1 : ability.target === 'floor' ? sf : sl;
        for (let target = 0; target < count; target++) activations.push({id, family, tier, target, kind:ability.target});
    }));
    let shopping, doors, spent, payout, finished, purchases;
    function initialize() {
        shopping = true; doors = spent = payout = 0; finished = false;
        purchases = Array(27).fill(0);
        R.points = options.startingCredits ?? 0;
        R.roundStats.creditsSpent = 0;
        R.roundStats.openingCredits = R.points;
        P.inventory = []; P.cart = [];
    }
    const has = (id, tier) => P.inventory.some(item => item.id === id && item.tier === tier);
    function canBuy(item) {
        const id = IDS[Math.floor(item / 3)], tier = item % 3;
        return shopping && P.isPowerUpAvailableForRound(id) && R.stats.round >= (C.GAME_DATA.shopUnlocks[id]?.[tier] || 1) && R.points >= P.catalog[id].tiers[tier].cost && (id !== 'doors' || limit < 0 || doors < limit);
    }
    function canActivate(a) {
        if (!a || shopping || !has(a.id, a.tier) || !P.isPowerUpAvailableForRound(a.id)) return false;
        if (a.kind === 'instant') return !P.isGlobalPowerUpActive(a.id);
        if (a.kind === 'floor') return a.target < R.floors.length;
        const lift = R.lifts[a.target];
        return !!lift && !P.isLiftPowerUpActive(a.id, lift) && (a.id !== 'wrench' || lift.jamTimer > 0);
    }
    function observe() {
        const out = Array.from(env.observe());
        out.push(R.points / 100, Number(shopping), doors / 4, spent / 100, payout / 100,
            P.timers.wideDoors > 0 ? C.boardingSpeedMultiplier : 0);
        IDS.forEach(id => { for (let tier = 0; tier < 3; tier++) out.push(P.inventory.filter(x => x.id === id && x.tier === tier).length / 4); });
        for (let lift = 0; lift < sl; lift++) {
            const car = R.lifts[lift] || {};
            IDS.forEach(id => out.push((car[TIMER[id]] || 0) / 60));
            out.push(car.turboTimer > 0 ? car.activeTurboSpeed || .1 : 0);
            out.push(car.wideDoorsTimer > 0 ? 1 / (car.wideDoorsMultiplier || 1) : 0);
        }
        return out;
    }
    function actionMask() {
        const out = new Array(start + 1 + activations.length).fill(0);
        if (shopping) {
            out[start] = 1;
            for (let item = 0; item < 27; item++) out[purchase + item] = Number(canBuy(item));
        } else {
            const old = env.actionMask();
            for (let i = 0; i <= noop; i++) out[i] = old[i];
            activations.forEach((a, i) => { out[start + 1 + i] = Number(canActivate(a)); });
        }
        return out;
    }
    initialize();
    return {
        observationSize: env.observationSize + 33 + sl * 11,
        actionCount: start + 1 + activations.length,
        observe, actionMask,
        purchaseCounts: () => purchases.slice(),
        snapshot: () => env.snapshot(), metrics: () => env.metrics(),
        heuristicAction: () => shopping ? start : env.heuristicAction(),
        reset(seed) { env.reset(seed); initialize(); return observe(); },
        step(action) {
            if (finished) return env.step(noop);
            if (shopping) {
                if (action === start) shopping = false;
                else if (action >= purchase && action < start && canBuy(action - purchase)) {
                    const item = action - purchase, id = IDS[Math.floor(item / 3)], tier = item % 3;
                    context.addToCart(id, tier);
                    context.checkoutCart();
                    purchases[item]++;
                    spent = R.roundStats.creditsSpent;
                    if (id === 'doors') doors++;
                }
                return {reward:0, terminated:false, truncated:false};
            }
            const a = activations[action - start - 1];
            if (canActivate(a)) {
                P.primeAbility(a.id, a.tier);
                if (a.kind !== 'instant') P.resolveTargeting(a.kind === 'lift' ? a.target : 0, a.kind === 'floor' ? a.target : 0);
            }
            const transition = env.step(action <= noop ? action : noop);
            if (transition.terminated || transition.truncated) {
                finished = true;
                const completed = transition.terminated && (R.stats.round === 12 ? R.stats.lives <= 0 : R.stats.timeLeft <= 0 && R.stats.lives > 0);
                if (completed) payout = context.evaluateRoundPayout().pointsEarned;
            }
            return transition;
        },
    };
}
window.bogeoWithShop = withShop;
