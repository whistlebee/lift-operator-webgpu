// Qualified campaign planning. These functions select ordinary paid actions;
// they never edit the game's credits, inventory, unlocks or purchase limits.
export const ITEM_PRICES=Object.freeze([1,3,5,1,3,5,2,4,8,1,3,5,1,2,3,2,3,5,1,2,3,2,3,5,2,4,6]);
export const ITEM_UNLOCKS=Object.freeze([6,6,12,9,9,12,8,8,12,7,7,12,3,4,12,10,10,12,11,11,12,22,22,22,10,10,12]);
const integer=(value,lo,hi)=>Number.isInteger(value)&&value>=lo&&value<=hi;
export function itemAvailable(item,round){return ITEM_UNLOCKS[item]<=round&&!(round>=24&&[1,5,6].includes(Math.floor(item/3)));}
function counts(values){if(!values||values.length!==27||!Array.from(values).every(n=>integer(n,0,1000000)))throw Error('Invalid paid purchase counts');}

export function equalCostBasket(original,round,arm){
  counts(original);if(!integer(round,1,25)||!integer(arm,0,81))throw Error('Invalid shop exchange');
  const result=Int32Array.from(original);if(arm===0)return result;
  const target=Math.floor((arm-1)/3);if(!itemAvailable(target,round))return result;
  const spent=Array.from(original).reduce((sum,n,item)=>sum+n*ITEM_PRICES[item],0);
  const cap=Math.min(48,Math.floor(spent/(4>>((arm-1)%3)))),price=ITEM_PRICES[target];
  const predecessor=new Int32Array(cap+1).fill(-1);predecessor[0]=-2;
  for(let item=0;item<27;item++){
    if(item===target)continue;
    const cost=ITEM_PRICES[item];
    for(let unit=0;unit<Math.min(original[item],Math.floor(cap/cost));unit++){
      for(let amount=cap;amount>=cost;amount--)if(predecessor[amount]===-1&&predecessor[amount-cost]!==-1)predecessor[amount]=item;
    }
  }
  for(let units=Math.floor(cap/price);units>0;units--){
    let amount=units*price;if(predecessor[amount]<0)continue;
    result[target]+=units;
    while(amount>0){const item=predecessor[amount];result[item]--;amount-=ITEM_PRICES[item];}
    break;
  }
  return result;
}

export function musakForTurbos(original,round,keep){
  counts(original);if(!integer(round,1,25)||!integer(keep,-1,10))throw Error('Invalid Musak/Turbo exchange');
  const result=Int32Array.from(original);
  if(keep===-1||![8,11,13].every(item=>itemAvailable(item,round)))return result;
  if(ITEM_PRICES[8]+ITEM_PRICES[13]!==2*ITEM_PRICES[11])throw Error('Exchange prices differ');
  const trades=Math.max(0,Math.floor((original[11]-keep)/2));
  result[11]-=2*trades;result[8]+=trades;result[13]+=trades;return result;
}

export function validateItemTiming({musakSeconds=0,musakProfile=0,turboSeconds=0,turboProfile=0}={}){
  if(!integer(musakSeconds,0,60)||!integer(turboSeconds,0,60)||!integer(musakProfile,0,1)||!integer(turboProfile,0,2))throw Error('Invalid item timing');
}
export function applyItemTiming(observations,mask,source,{musakSeconds=0,musakProfile=0,turboSeconds=0,turboProfile=0}={}){
  validateItemTiming({musakSeconds,musakProfile,turboSeconds,turboProfile});
  const logits=source.slice();
  for(const [seconds,profile,action,value] of [[musakSeconds,musakProfile,843,1e6],[turboSeconds,turboProfile,884,1e5]]){
    if(seconds===0||!mask[action])continue;
    logits[action]=-1e6;
    const threshold=Math.fround(seconds/60);
    for(let slot=0;slot<1024;slot++){
      const p=4344+slot*15;if(observations[p]<=0||observations[p]>=1)break;
      const eligible=profile===0||observations[p+4]>0||(profile===2&&observations[p]>Math.fround(30.5/51));
      if(observations[p+2]>=threshold&&observations[p+9]===0&&eligible){logits[action]=value;break;}
    }
  }
  return logits;
}

export class ShopPlan {
  constructor(budget,exchange){
    if(budget.kind!=='campaign_shop_budget'||budget.schema!==1||!integer(budget.max_cash,0,10000)||
       !Array.isArray(budget.reserves)||budget.reserves.length!==25||!Array.isArray(budget.fallback)||budget.fallback.length!==25||
       !budget.fallback.every(n=>integer(n,0,1000000))||budget.reserves.some(row=>!Array.isArray(row)||row.length!==budget.max_cash+1||!row.every(n=>integer(n,0,1000000))))throw Error('Invalid budget model');
    if(exchange.kind!=='campaign_shop_exchange'||exchange.schema!==1||!Array.isArray(exchange.rounds)||exchange.rounds.length!==25||
       exchange.rounds.some(row=>!Array.isArray(row)||row.length>1||!row.every(n=>integer(n,0,81))))throw Error('Invalid exchange model');
    const specs={gold_musak_age_seconds:[0,60,'rounds',true],gold_musak_vip_only:[0,1,'gold_musak_age_seconds',false],
      gold_musak_turbos_to_keep:[-1,10,'rounds',false],gold_turbo_age_seconds:[0,60,'rounds',true],
      gold_turbo_target_profile:[0,2,'gold_turbo_age_seconds',false]};
    for(const [key,[lo,hi,parent,locked]] of Object.entries(specs))if(key in exchange){
      const rows=exchange[key];
      if(!Array.isArray(rows)||rows.length!==25||!Array.isArray(exchange[parent])||rows.some((row,r)=>!Array.isArray(row)||
         !row.every(n=>integer(n,lo,hi))||(locked?row.length>0&&(row.length!==exchange[parent][r].length||r<11):row.length!==exchange[parent][r].length)))throw Error(`Invalid exchange option: ${key}`);
    }
    this.budget=structuredClone(budget);this.exchange=structuredClone(exchange);this.round=0;
  }
  reserve(round,opening){
    if(!integer(round,1,25)||!integer(opening,0,1000000))throw Error('Invalid opening shop state');
    return opening>this.budget.max_cash?this.budget.fallback[round-1]:this.budget.reserves[round-1][opening];
  }
  reset(round,opening){
    this.limit=this.reserve(round,opening);this.round=round;this.opening=opening;
    this.preparing=this.exchange.rounds[round-1].length>0;this.exchanged=this.preparing;this.desired=null;
  }
  timing(){
    if(!this.round)throw Error('Shop plan must be reset');
    if(this.preparing)return {};
    const value=key=>this.exchange[key]?.[this.round-1]?.[0]??0;
    return {musakSeconds:value('gold_musak_age_seconds'),musakProfile:value('gold_musak_vip_only'),
      turboSeconds:value('gold_turbo_age_seconds'),turboProfile:value('gold_turbo_target_profile')};
  }
  choose(logits,mask,originalChoices,{shop,credits,purchases,done=false}){
    if(!this.round)throw Error('Shop plan must be reset');
    counts(purchases);if(!integer(credits,0,1000000))throw Error('Invalid current credits');
    const choices=Int32Array.from(originalChoices);
    if(!shop)return {choices,restart:false};
    let selected=777,best=Math.fround(-3.4028235e38);
    for(let action=750;action<778;action++)if(mask[action]&&logits[action]>best){selected=action;best=logits[action];}
    const item=selected-750;if(item>=0&&item<27&&credits-ITEM_PRICES[item]<this.limit)selected=777;
    choices[20]=selected-620;
    if(this.exchanged&&!this.preparing&&this.desired&&!done){
      choices.fill(30,0,20);choices[20]=157;
      for(let item=0;item<27;item++)if(purchases[item]<this.desired[item]&&mask[750+item]){choices[20]=130+item;break;}
    }
    if(this.preparing&&choices[20]===157){
      let desired=equalCostBasket(purchases,this.round,this.exchange.rounds[this.round-1][0]);
      const keep=this.exchange.gold_musak_turbos_to_keep?.[this.round-1]?.[0];
      if(keep!==undefined)desired=musakForTurbos(desired,this.round,keep);
      this.desired=desired.some((n,i)=>n!==purchases[i])?desired:null;this.preparing=false;
      // Caller restarts only the still-paused shop with the same seed/opening
      // cash and clears recurrent memory. Purchases must go through checkout.
      return {choices,restart:true};
    }
    return {choices,restart:false};
  }
}
