import {LiftPolicy} from './policy.mjs';
import {DistilledShop} from './distilled_shop.mjs';
import {DistilledLifts} from './distilled_lifts.mjs';
import {validateItemTiming} from './item_timing.mjs';

export function distilledConfiguration(c){
 if(!c||c.schema!==1||c.kind!=='distilled_campaign'||c.frames_per_action!==15||c.sampler_seed!==20261103||
    Object.keys(c).some(k=>!['schema','kind','frames_per_action','sampler_seed','reset_shop_memory_rounds','item_timing'].includes(k))||
    !Array.isArray(c.reset_shop_memory_rounds)||c.reset_shop_memory_rounds.some(r=>!Number.isInteger(r)||r<1||r>25)||new Set(c.reset_shop_memory_rounds).size!==c.reset_shop_memory_rounds.length||
    !Array.isArray(c.item_timing)||c.item_timing.length!==25)throw Error('Invalid distilled policy settings');
 for(const t of c.item_timing){if(Object.keys(t).some(k=>!['musakSeconds','musakProfile','turboSeconds','turboProfile'].includes(k)))throw Error('Unexpected item timing setting');validateItemTiming(t);}
 return {resetRounds:new Set(c.reset_shop_memory_rounds),timing:structuredClone(c.item_timing)};
}
// One shared learned shop and one shared learned lift scorer. No per-round lift
// rules, private VIP reservation, reserve table or basket substitution is loaded.
export class CampaignPolicy{
 static async create(device,assets){
  const self=new CampaignPolicy();self.busy=false;self.round=0;self.controls=distilledConfiguration(assets.configuration);
  try{self.policy=await LiftPolicy.create(device,assets);self.shop=await DistilledShop.create(device,assets.shopModel,assets.shopMetadata);self.lifts=await DistilledLifts.create(device,assets.liftModel,assets.liftMetadata);return self;}catch(e){self.destroy();throw e;}
 }
 async request(packet){
  if(this.busy)throw Error('Campaign inference busy');const integer=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max;
  if(packet.reset){
   if(!integer(packet.round,1,25)||!integer(packet.roundSeed,1,0xffffffff)||!integer(packet.credits,0,1000000))throw Error('Invalid campaign reset');
   this.round=packet.round;this.seed=packet.roundSeed;this.shop.reset();this.lifts.reset();this.resetState=true;return {action:null};
  }
    const c=packet.context;
    if(!this.round||!Array.isArray(packet.observation)||packet.observation.length!==19704||!packet.observation.every(Number.isFinite)||
       !Array.isArray(packet.mask)||packet.mask.length!==1062||!packet.mask.every(n=>n===0||n===1)||!packet.mask.some(Boolean)||
       !Array.isArray(c)||c.length!==79||!c.every(Number.isInteger)||!integer(c[0],0,3600)||!integer(c[1],0,59)||
       !integer(c[2],1,30)||!integer(c[3],1,20)||c.slice(4,12).some(n=>!integer(n,0,3600))||
       c.slice(12,39).some(n=>!integer(n,0,1000000))||c.slice(39,59).some(n=>!integer(n,-1,19))||c.slice(59).some(n=>n!==0&&n!==1))throw Error('Invalid campaign state');
    const obs=Float32Array.from(packet.observation),mask=Int32Array.from(packet.mask),shop=obs[2410]!==0;
    if(obs[this.round-1]!==1||obs.slice(0,25).some((n,i)=>n!==(i===this.round-1?1:0)))throw Error('Wrong active round');
    const purchases=c.slice(12,39),credits=Math.round(Math.fround(obs[2409]*100));
    const context={key:20261103,roundSeed:this.seed,elapsed:c[0],phase:c[1],floors:c[2],lifts:c[3],framesPerAction:15,
      purchases,shop,done:false,partners:Int32Array.from(c.slice(39,59)),doubleDeckMask:c.slice(59).reduce((bits,n,i)=>bits|(n<<i),0)};

  this.busy=true;
  try{
   this.lifts.prepare(obs);
   const reset=this.resetState||(!shop&&c[0]===0&&c[1]===0&&this.controls.resetRounds.has(this.round));
   const neural=await this.policy.step(obs,mask,context,{reset,timing:this.controls.timing[this.round-1]});this.resetState=false;
   let choices=await this.lifts.choose(obs,mask,neural.hidden,neural.choices,context);
   const spent=Math.round(Math.fround(obs[2412]*100));
   choices=await this.shop.choose(obs,neural.mask,choices,credits,spent,purchases);
   if(choices.length!==21||choices.some((n,i)=>!Number.isInteger(n)||n<0||n>(i<20?30:441)))throw Error('Invalid distilled action');
   const global=choices[20]+620;return {action:global===620?600:global,lifts:Array.from(choices.slice(0,20))};
  }catch(e){this.round=0;throw e;}finally{this.busy=false;}
 }
 destroy(){this.policy?.destroy();this.shop?.destroy();this.lifts?.destroy();}
}

export async function loadCampaignAssets(base){
  const manifestResponse=await fetch(new URL('../policy-manifest.json',base),{cache:'no-store'});
  if(!manifestResponse.ok)throw Error('Policy manifest unavailable');
  const manifest=await manifestResponse.json();
  if(manifest.schema!==2||!manifest.weights)throw Error('Unsupported policy manifest');
  const read=async(name,binary=false)=>{
    const expected=manifest.weights[name];if(!/^[a-f0-9]{64}$/.test(expected??''))throw Error(`Missing policy hash: ${name}`);
    const r=await fetch(new URL(name+'?sha='+expected,base),{cache:'no-store'});if(!r.ok)throw Error(`Unable to load ${name}`);
    const bytes=await r.arrayBuffer(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
    if(hash!==expected)throw Error(`Policy file differs from manifest: ${name}`);
    return binary?bytes:JSON.parse(new TextDecoder().decode(bytes));
  };
  const names={model:['model.bin',true],modelMetadata:['model.bin.json'],policyMetadata:['model.bin.policy.json'],
    itemModel:['model.bin.item-activation-head.bin',true],itemMetadata:['model.bin.item-activation-head.bin.json'],itemFeatures:['model.bin.item-activation.json'],
    shopModel:['shop.bin',true],shopMetadata:['shop.bin.json'],liftModel:['lift.bin',true],liftMetadata:['lift.bin.json'],configuration:['distilled-policy.json']};
  const assets=Object.fromEntries(await Promise.all(Object.entries(names).map(async([key,args])=>[key,await read(...args)])));
  return assets;
}
