import {LiftControllers} from './controllers.mjs';
import {FloorDispatch,dispatchConfiguration} from './dispatch.mjs';

export const VIP_RESPONDER_ROUNDS=Object.freeze([8,10,15,16,17,18,19,20]);
const ORDINARY_ROUNDS=Object.freeze([6,8,9,10,14,15,16,17,18,19,22]);

// The campaign bundle's post-sampling order. It leaves the global item head
// untouched. Paid shopping and neural inference are separate stages.
export class CampaignControllers{
  static async create(device,{ordinary,coupled,capsule}){
    if(!ordinary||Object.keys(ordinary).length!==ORDINARY_ROUNDS.length)throw Error('Incomplete campaign dispatch bundle');
    for(const round of ORDINARY_ROUNDS){
      const model=ordinary[round];if(!model||model.round!==round)throw Error(`Missing round ${round} dispatch`);
      dispatchConfiguration(model);
    }
    if(coupled?.round!==23)throw Error('Missing coupled dispatch');dispatchConfiguration(coupled);
    const self=new CampaignControllers();self.models=structuredClone({ordinary,coupled});self.busy=false;
    try{self.floors=await FloorDispatch.create(device);self.special=await LiftControllers.create(device,capsule);return self;}
    catch(e){self.destroy();throw e;}
  }
  serviceOptions(round){
    const model=this.models.ordinary[round];
    return {vipEmptyDepartures:model?dispatchConfiguration(model).vipEmptyDepartures:false};
  }
  async apply(obs,logits,mask,choices,context){
    if(this.busy)throw Error('Campaign controllers busy');
    const rounds=Array.from(obs.slice(0,25)).flatMap((n,i)=>n===1?[i+1]:[]);
    if(rounds.length!==1)throw Error('Expected exactly one round indicator');
    const round=rounds[0];this.busy=true;
    try{
      let result=choices.slice();const model=this.models.ordinary[round]??(round===23?this.models.coupled:null);
      if(model)result=await this.floors.apply(model,obs,logits,mask,result,context);
      if((model?.redirect_empty_vip&&round===14)||VIP_RESPONDER_ROUNDS.includes(round))result=await this.special.apply('vip',obs,mask,result,context);
      if(round===25)result=await this.special.apply('capsule',obs,mask,result,context);
      return result;
    }finally{this.busy=false;}
  }
  destroy(){this.floors?.destroy();this.special?.destroy();}
}
