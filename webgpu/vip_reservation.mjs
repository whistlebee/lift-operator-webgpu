// Public-history counterpart of trainer/vip_reservation.mojo. Only a previously
// visible destination is remembered; hidden VIP schedules are never consulted.
const f=Math.fround;
const decode=(value,scale)=>Math.trunc(f(f(value*scale)+.5));
export class VipReservation{
  constructor(){this.reset();}
  reset(){this.history=new Int32Array(6).fill(-1);}
  prepare(obs,rawMask,done=false){
    const h=this.history;
    if(done||obs[7]===0||obs[2410]!==0){this.reset();return null;}
    const floors=decode(obs[25],30),cars=decode(obs[26],20),stage=decode(obs[4118],3),now=180-decode(obs[27],180);
    let waiting=-1,blocked=-1;
    for(let slot=0;slot<1024;slot++){
      const record=4344+15*slot,group=decode(obs[record],51)-1;
      if(group<0)break;
      if(obs[record+4]===0)continue;
      if(group>=30&&group<30+cars){
        h[0]=stage;h[1]=decode(obs[record+1],30)-1;h[2]=group-30;
        h[3]=h[4]=h[5]=-1;return null;
      }
      if(group<floors){
        waiting=group;
        if(obs[record+13]!==0&&decode(obs[record+12],30)-1===group)blocked=decode(obs[record+11],20)-1;
        break;
      }
    }
    let origin=waiting;
    if(waiting<0){
      if(h[0]<1||h[0]>2||stage!==h[0]+1)return null;
      if(h[3]<0){h[3]=now;h[4]=h[1];}
      if(now-h[3]>31){h[0]=h[5]=-1;return null;}
      origin=h[4];
    }else{h[0]=h[3]=-1;}
    if(origin<0||origin>=floors)return null;
    let best=f(1e10),plan=null;
    for(let car=0;car<cars;car++){
      const base=271+69*car;
      if(obs[2842+car]===0||obs[base+2]!==0||obs[base+6]!==0||obs[base+7]!==0||obs[3160+18*car]!==0||car===blocked)continue;
      const position=f(obs[base]*(floors-1)),target=decode(obs[base+1],floors-1);
      for(let floor=0;floor<floors;floor++){
        if(waiting>=0){if(floor!==waiting||obs[3514+30*car+floor]<=0)continue;}
        else if(obs[3514+30*car+floor]>0||(car===h[2]&&floor===origin))continue;
        const command=floor===target?30:floor;
        if(command!==30&&rawMask[30*car+floor]===0)continue;
        let cost=f(Math.abs(f(position-floor))+Math.abs(floor-origin));
        if(floor===target)cost=f(cost-.25);
        if(car===h[5])cost=f(cost-.5);
        if(cost<best){best=cost;plan={car,command};}
      }
    }
    h[5]=plan?.car??-1;return plan;
  }
  apply(plan,mask,choices){
    if(!plan)return;
    choices[plan.car]=plan.command;
    if(plan.command!==30)mask[31*plan.car+plan.command]=1;
  }
}

export function campaignControls(value={}){
  const {reset_shop_memory_rounds=[],vip_reservation=false}=value;
  if(Object.keys(value).some(k=>!['reset_shop_memory_rounds','vip_reservation'].includes(k))||
     !Array.isArray(reset_shop_memory_rounds)||reset_shop_memory_rounds.some(r=>!Number.isInteger(r)||r<1||r>25)||
     new Set(reset_shop_memory_rounds).size!==reset_shop_memory_rounds.length||typeof vip_reservation!=='boolean')throw Error('Invalid campaign controls');
  return {resetRounds:new Set(reset_shop_memory_rounds),vip:vip_reservation};
}
