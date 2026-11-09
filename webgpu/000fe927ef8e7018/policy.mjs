// Frozen base policy. The distilled shop and lift networks complete inference.
import {LiftNetwork} from './network.mjs';
import {FleetTransform} from './fleet.mjs';
import {PolicyPrograms} from './programs.mjs';
import {ItemBank} from './items.mjs';
import {buildItemInputs,itemFeatureConfiguration} from './item_features.mjs';
import {FleetSampler,fleetDraws} from './sampling.mjs';
import {applyItemTiming,validateItemTiming} from './item_timing.mjs';

export class LiftPolicy {
  static async create(device,{model,modelMetadata,policyMetadata,itemModel,itemMetadata,itemFeatures}){
    // The physical routing shader currently implements this exact policy ABI.
    const required={schema_version:16,dispatch_score_scale:0,routing_context_rms:true,
      manual_retarget:true,dispatch_gate:false,dispatch_choice:false,service_mask:true,
      all_lifts:true,switch_cooldown_frames:0,integrated_shop:true,activation_head:false,
      item_activation:true,eligible_vip_scoring:true,boardable_pickup_scoring:true,
      boardable_count_scoring:true};
    for(const [key,value] of Object.entries(required))if(policyMetadata[key]!==value)throw Error(`Unsupported policy option: ${key}`);
    const self=new LiftPolicy();self.resources=[];self.busy=false;
    self.features=itemFeatureConfiguration(itemFeatures);
    self.options={oldest:policyMetadata.oldest_cargo_strength,loaded:policyMetadata.loaded_pickup_strength,
      wrench:policyMetadata.shop_wrench_penalty,other:policyMetadata.shop_other_stock_penalty,
      otherItem:policyMetadata.shop_other_stock_item};
    if(!['oldest','loaded','wrench','other'].every(k=>Number.isFinite(self.options[k])&&self.options[k]>=0)||
       self.options.oldest>64||self.options.loaded>1||!Number.isInteger(self.options.otherItem)||
       self.options.otherItem< -1||self.options.otherItem===0||self.options.otherItem>=27)throw Error('Invalid saved score programs');
    try{
      self.network=await LiftNetwork.create(device,model,modelMetadata);self.resources.push(self.network);
      const weights=new Float32Array(model).slice(modelMetadata.parameter_offsets[3],modelMetadata.parameter_offsets[3]+372);
      self.programs=await PolicyPrograms.create(device,weights);self.resources.push(self.programs);
      self.fleet=await FleetTransform.create(device);self.resources.push(self.fleet);
      self.items=await ItemBank.create(device,itemModel,itemMetadata);self.resources.push(self.items);
      self.sampler=await FleetSampler.create(device);self.resources.push(self.sampler);
      return self;
    }catch(error){self.destroy();throw error;}
  }

  async step(observation,legal,context,{reset=false,timing=null,vipEmptyDepartures=false}={}){
    if(this.busy)throw Error('A policy step is already running');
    const {floors,lifts,partners,doubleDeckMask=0,done=false}=context;
    // Validate all external inputs before advancing recurrent state.
    if(!(observation instanceof Float32Array)||observation.length!==19704||!observation.every(Number.isFinite)||
       !(legal instanceof Int32Array)||legal.length!==1062||!legal.every(x=>x===0||x===1)||
       !(partners instanceof Int32Array)||partners.length!==20||!partners.every(x=>x>=-1&&x<20)||
       !Number.isInteger(floors)||floors<1||floors>30||!Number.isInteger(lifts)||lifts<1||lifts>20||
       Math.round(observation[25]*30)!==floors||Math.round(observation[26]*20)!==lifts||
       ![false,true,0,1].includes(done)||![false,true,0,1].includes(context.shop)||
       !Number.isInteger(doubleDeckMask)||doubleDeckMask<0||doubleDeckMask>=2**20)throw Error('Invalid policy state');
    if(typeof vipEmptyDepartures!=='boolean'||vipEmptyDepartures&&observation[7]!==1)throw Error('VIP departures supported only in round 8');
    const draws=fleetDraws(context);
    if(timing!==null)validateItemTiming(timing);
    let pairFloors=0;
    if(observation[20]>.5)pairFloors=11;
    if(observation[21]>.5)pairFloors=15;
    if(observation[22]>.5)pairFloors=29;
    const transform={floors,lifts,done,pairFloors,serviceObservation:observation,vipEmptyDepartures};
    this.busy=true;
    try{
      const network=await this.network.step(observation,{reset});
      // The raw residuals require the service-protected fleet mask. Reuse the
      // verified transform to form it before producing the final packed scores.
      const protectedFleet=await this.fleet.transform(network.routed,legal,partners,transform);
      const raw=await this.programs.apply('raw',observation,protectedFleet.mask,network.routed,
        {...this.options,doubleDeckMask,done});
      const base=await this.fleet.transform(raw,legal,partners,transform);
      const {inputs}=buildItemInputs(observation,base.logits,base.logits,base.mask,this.features);
      const items=await this.items.forward(inputs,this.features.enabled,base.logits);
      let logits=await this.programs.apply('shop',observation,base.mask,items.logits,{...this.options,done});
      if(timing!==null)logits=applyItemTiming(observation,base.mask,logits,timing);
      const sampled=await this.sampler.sample(logits,base.mask,draws);
      return {...sampled,logits,mask:base.mask,draws,state:network.state,hidden:network.hidden,base:base.logits,itemInputs:inputs};
    }finally{this.busy=false;}
  }

  destroy(){for(const resource of this.resources)resource.destroy();this.resources=[];}
}
