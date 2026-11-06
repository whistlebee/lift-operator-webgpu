import {LiftPolicy} from './policy.mjs';
import {CampaignControllers} from './campaign_controllers.mjs';
import {ShopPlan} from './shop.mjs';
import {VipReservation,campaignControls} from './vip_reservation.mjs';

// The complete inference path. The original game owns purchases, inventory,
// physics, completion and credits; this class returns actions only.
export class CampaignPolicy{
  static async create(device,assets){
    const self=new CampaignPolicy();self.busy=false;self.round=0;
    self.controls=campaignControls(assets.campaignControls);self.vip=new VipReservation();
    self.shop=new ShopPlan(assets.budget,assets.exchange);
    try{
      self.policy=await LiftPolicy.create(device,assets);
      self.controllers=await CampaignControllers.create(device,assets);
      return self;
    }catch(e){self.destroy();throw e;}
  }
  async request(packet){
    if(this.busy)throw Error('Campaign inference busy');
    const integer=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max;
    if(packet.reset){
      if(!integer(packet.round,1,25)||!integer(packet.roundSeed,1,0xffffffff)||!integer(packet.credits,0,1000000))throw Error('Invalid campaign reset');
      this.shop.reset(packet.round,packet.credits);this.round=packet.round;this.seed=packet.roundSeed;
      this.vip.reset();
      this.resetState=true;this.expectRestart=false;return {action:null};
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
    if(this.expectRestart&&(!shop||c[0]!==0||c[1]!==0||purchases.some(Boolean)||credits!==this.shop.opening))throw Error('Shop restart must restore the same paused opening state');
    const context={key:20261103,roundSeed:this.seed,elapsed:c[0],phase:c[1],floors:c[2],lifts:c[3],framesPerAction:15,
      purchases,shop,done:false,partners:Int32Array.from(c.slice(39,59)),doubleDeckMask:c.slice(59).reduce((bits,n,i)=>bits|(n<<i),0)};
    this.busy=true;
    try{
      const plan=this.controls.vip?this.vip.prepare(obs,mask):null;
      const reset=this.resetState||(!shop&&c[0]===0&&c[1]===0&&this.controls.resetRounds.has(this.round));
      const neural=await this.policy.step(obs,mask,context,{reset,timing:this.shop.timing(),...this.controllers.serviceOptions(this.round)});
      this.resetState=false;this.expectRestart=false;
      const dispatch=await this.controllers.apply(obs,neural.logits,neural.mask,neural.choices,context);
      this.vip.apply(plan,neural.mask,dispatch);
      const result=this.shop.choose(neural.logits,neural.mask,dispatch,{shop,credits,purchases});
      if(result.restart){this.resetState=true;this.expectRestart=true;this.vip.reset();return {restartShop:true};}
      if(result.choices.length!==21||result.choices.some((n,i)=>!Number.isInteger(n)||n<0||n>(i<20?30:441))){
        this.lastFailure={packet,mask:Array.from(neural.mask),logits:Array.from(neural.logits),sampled:Array.from(neural.choices),dispatch:Array.from(dispatch)};
        console.error('Invalid campaign choices '+JSON.stringify({sampled:Array.from(neural.choices),dispatch:Array.from(dispatch),final:Array.from(result.choices),elapsed:c[0],phase:c[1]}));
        throw Error('Invalid campaign controller output');
      }
      const global=result.choices[20]+620;
      return {action:global===620?600:global,lifts:Array.from(result.choices.slice(0,20))};
    }catch(e){this.round=0;throw e;}finally{this.busy=false;}
  }
  destroy(){this.policy?.destroy();this.controllers?.destroy();}
}

export async function loadCampaignAssets(base){
  const manifestResponse=await fetch(new URL('../policy-manifest.json',base));
  if(!manifestResponse.ok)throw Error('Policy manifest unavailable');
  const manifest=await manifestResponse.json();
  if(manifest.schema!==1||!manifest.weights)throw Error('Unsupported policy manifest');
  const read=async(name,binary=false)=>{
    const expected=manifest.weights[name];if(!/^[a-f0-9]{64}$/.test(expected??''))throw Error(`Missing policy hash: ${name}`);
    const r=await fetch(new URL(name,base));if(!r.ok)throw Error(`Unable to load ${name}`);
    const bytes=await r.arrayBuffer(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
    if(hash!==expected)throw Error(`Policy file differs from manifest: ${name}`);
    return binary?bytes:JSON.parse(new TextDecoder().decode(bytes));
  };
  const names={model:['model.bin',true],modelMetadata:['model.bin.json'],policyMetadata:['model.bin.policy.json'],
    itemModel:['model.bin.item-activation-head.bin',true],itemMetadata:['model.bin.item-activation-head.bin.json'],itemFeatures:['model.bin.item-activation.json'],
    budget:['budget.json'],exchange:['exchange.json'],coupled:['coupled.json'],capsule:['capsule.json']};
  const assets=Object.fromEntries(await Promise.all(Object.entries(names).map(async([key,args])=>[key,await read(...args)])));
  if(manifest.weights['campaign-controls.json'])assets.campaignControls=await read('campaign-controls.json');
  assets.ordinary=Object.fromEntries(await Promise.all([6,8,9,10,14,15,16,17,18,19,22].map(async round=>[round,await read(`ordinary/round-${round}.json`)])));
  return assets;
}
