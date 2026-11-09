// Public-state feature encoding; the learned item networks run in items.mjs.
// Float32 operations preserve the native feature thresholds and accumulation.
import {ITEM_TARGET_COUNTS} from './items.mjs';
const f=Math.fround, add=(a,b)=>f(a+b), sub=(a,b)=>f(a-b), mul=(a,b)=>f(a*b), div=(a,b)=>f(a/b);
const clamp=(x,lo=0,hi=1)=>Math.max(lo,Math.min(hi,x));
const round=x=>Math.trunc(add(x,.5));
const starts=ITEM_TARGET_COUNTS.map((_,i)=>778+ITEM_TARGET_COUNTS.slice(0,i).reduce((a,b)=>a+b,0));

export function itemFeatureConfiguration(metadata){
  if(metadata.schema_version!==5||!Array.isArray(metadata.items)||
     ['prior_limits','feature_bases','feature_profiles'].some(k=>!Array.isArray(metadata[k])||metadata[k].length!==metadata.items.length)||
     !Array.isArray(metadata.legacy_prior_exclusions)||metadata.legacy_prior_exclusions.length)throw Error('Unsupported item feature metadata');
  const enabled=new Int32Array(27),bases=new Int32Array(27),profiles=new Int32Array(27),priors=new Float32Array(27);
  metadata.items.forEach((item,i)=>{
    const base=metadata.feature_bases[i],profile=metadata.feature_profiles[i],prior=metadata.prior_limits[i];
    if(!Number.isInteger(item)||item<0||item>=27||enabled[item]||![0,1].includes(base)||
       !Number.isInteger(profile)||profile<0||profile>3||((profile&1)&&!(item>=3&&item<=7))||
       !Number.isFinite(prior)||prior<=0)throw Error('Invalid item feature metadata');
    enabled[item]=1;bases[item]=base;profiles[item]=profile;priors[item]=prior;
  });
  return {enabled,bases,profiles,priors};
}

function liftFeatures(o,lift,family){
  const load=clamp(o[3156+lift*18]),presence=clamp(o[2842+lift]),age=clamp(o[2668+lift*9]);
  const timer=clamp(o[2442+lift*11+family]);let hazard=0,context=age;
  if(family===0)hazard=clamp(o[4134+lift*6]);
  else if(family===1)hazard=clamp(o[4135+lift*6],-1);
  else if(family===2){hazard=age;context=clamp(o[2669+lift*9]);}
  else if(family===3){hazard=clamp(o[2667+lift*9]);context=clamp(o[2663+lift*9]);}
  else if(family>=4&&family<=6){
    let waiting=0;for(let floor=0;floor<30;floor++)waiting=Math.max(waiting,o[3514+lift*30+floor]);
    const floors=Math.max(1,sub(mul(o[25],30),1)),current=clamp(round(mul(o[271+lift*69],floors)),0,29);
    hazard=clamp(Math.max(waiting,o[31+current*7]));
    if(family===4)context=Math.max(o[2664+lift*9],o[2665+lift*9]);
    else if(family===5)context=Math.max(load,o[3165+lift*18]);
    else context=clamp(div(o[3157+lift*18],2));
  }else if(family===7){
    let potential=0;const position=o[271+lift*69],target=o[272+lift*69],floors=Math.max(1,sub(mul(o[25],30),1));
    const service=Math.max(o[2664+lift*9],o[276+lift*69]);
    for(let neighbor=Math.max(0,lift-1);neighbor<Math.min(20,lift+2);neighbor++){
      if(neighbor===lift||o[2842+neighbor]<=0)continue;
      const neighborService=Math.max(o[2664+neighbor*9],o[276+neighbor*69]);
      if(mul(Math.abs(sub(position,o[271+neighbor*69])),floors)>f(.2)||service<=0||neighborService<=0)continue;
      for(let destination=0;destination<30;destination++){
        const normalized=div(destination,floors);
        if(Math.abs(sub(o[272+neighbor*69],normalized))<Math.abs(sub(target,normalized)))potential=add(potential,o[279+lift*69+destination]);
      }
    }
    hazard=clamp(potential);context=service;
  }else{
    let total=0,majority=0;
    for(let destination=0;destination<30;destination++){const value=o[279+lift*69+destination];total=add(total,value);majority=Math.max(majority,value);}
    if(total>0)hazard=div(sub(total,majority),total);
  }
  return [load,hazard,presence,clamp(context),timer];
}

const expiry=(seconds,phase)=>Math.max(0,add(sub(seconds,1),phase>0?sub(1,phase):0));
function inZone(o,lift,position,floors){
  if(o[3088]<=0)return true;
  const current=round(position),lower=round(mul(o[3158+lift*18],floors)),upper=round(mul(o[3159+lift*18],floors));
  return current===0||(current>=lower&&current<=upper);
}
function travel(o,lift,begin,end,delay,floors){
  let speed=Math.max(f(.01),mul(mul(f(.96),5),o[3092]));
  if(end>begin)speed=mul(speed,clamp(o[3157+lift*18],f(.1)));
  const partner=round(mul(o[3160+lift*18],20))-1;
  const lower=mul(o[3158+lift*18],floors),upper=mul(o[3159+lift*18],floors);
  let outside=!inZone(o,lift,begin,floors)&&!inZone(o,lift,end,floors)&&((begin<lower&&end<lower)||(begin>upper&&end>upper));
  if(outside&&partner>=0&&partner<20){
    const position=add(mul(o[271+partner*69],floors),sub(mul(o[271+lift*69],floors),begin));
    outside=!inZone(o,partner,position,floors)&&!inZone(o,partner,sub(add(position,begin),end),floors);
  }
  if(outside)speed=mul(speed,2);
  let boost=1,timer=0;
  if(o[4127]>0){timer=mul(o[4127],60);boost=partner>=0?10:20;}
  else if(o[2445+lift*11]>0){
    timer=mul(o[2445+lift*11],60);let scalar=Math.max(f(.01),o[2451+lift*11]);
    if(partner>=0)scalar=mul(scalar,2);boost=div(1,scalar);
  }else if(partner>=0&&partner<20&&o[2445+partner*11]>0){
    timer=mul(o[2445+partner*11],60);boost=div(1,Math.max(f(.02),mul(o[2451+partner*11],2)));
  }
  if(timer>0&&o[3090]>0)boost=f(1.15);
  const distance=Math.abs(sub(end,begin)),remaining=Math.max(0,sub(expiry(timer,o[4123]),delay)),boosted=mul(speed,boost);
  const boostedDistance=mul(boosted,remaining);
  return distance<=boostedDistance?div(distance,boosted):add(remaining,div(sub(distance,boostedDistance),speed));
}

function musakProfile(o,lift){
  if(o[2842+lift]<=0)return [0,0,0,0,0,f(-1e30)];
  const floors=Math.max(1,sub(mul(o[25],30),1)),position=mul(o[271+lift*69],floors);
  const target=round(mul(o[272+lift*69],floors)),phase=o[4123];
  let jam=expiry(mul(o[4134+lift*6],20),phase);
  if(Math.abs(sub(position,target))>f(.2))jam=Math.max(jam,expiry(mul(o[3161+lift*18],10),phase));
  const double=o[3090]<=0&&(o[2448+lift*11]>0||o[4130]>0);
  const stinky=o[278+lift*69]>0&&o[2443+lift*11]<=0&&o[4125]<=0;
  const musak=o[2444+lift*11]>0||o[4126]>0;
  let totalWeight=0,criticalWeight=0,dropWeight=0,lastDropWeight=0;
  const passengers=[];
  for(let guest=0;guest<1024;guest++){
    const offset=4344+guest*15;if(o[offset]<=0)break;
    const group=round(mul(o[offset],51))-1;if(group>30+lift)break;if(group!==30+lift)continue;
    const destination=round(mul(o[offset+1],30))-1;
    if(destination<0||destination>floors)continue;
    passengers.push([offset,destination]);
    const weight=Math.max(0,mul(o[offset+3],3));totalWeight=add(totalWeight,weight);
    if(o[offset+2]>div(2,3))criticalWeight=add(criticalWeight,weight);
    if(destination===target||(double&&destination===target+1)||(stinky&&o[offset+5]<=0)){
      dropWeight=add(dropWeight,weight);lastDropWeight=weight;
    }
  }
  const door=div(.5,f(.96));let scalar=1;
  if(o[4129]>0)scalar=mul(scalar,Math.max(f(.01),o[2414]));
  if(o[2446+lift*11]>0)scalar=mul(scalar,Math.max(f(.01),o[2452+lift*11]));
  const lastWeight=Math.max(1,mul(o[3163+lift*18],3)),progress=clamp(o[2666+lift*9]);
  let opening=door,closing=door,interval=mul(mul(door,scalar),lastWeight);
  if(o[2664+lift*9]>0)opening=mul(opening,sub(1,progress));
  else if(o[276+lift*69]>0){opening=0;interval=mul(interval,sub(1,progress));}
  else if(o[2665+lift*9]>0){opening=0;closing=mul(closing,sub(1,progress));}
  const boards=Math.max(0,mul(o[3514+lift*30+target],10));
  let nextLastWeight=lastDropWeight>0?lastDropWeight:lastWeight;if(boards>0)nextLastWeight=1;
  let service=0;
  if(dropWeight>0||boards>0||o[3165+lift*18]>0||o[2664+lift*9]>0||o[276+lift*69]>0||o[2665+lift*9]>0){
    service=add(add(add(opening,interval),mul(mul(door,scalar),add(dropWeight,boards))),closing);
    if(o[2665+lift*9]>0)service=closing;
  }
  const firstLeg=add(jam,travel(o,lift,position,target,jam,floors));
  const weights=new Float32Array(32),counts=new Float32Array(32);
  let currentWeight=0,currentCount=0,selectedAge=0,selectedEta=0,selectedRate=0,pressure=f(-1e30);
  for(const [offset,destination] of passengers){
    const age=mul(o[offset+2],60);let rate=1;
    if(stinky&&o[offset+5]<=0&&o[offset+7]<=0)rate++;if(musak)rate--;
    let landing=destination;
    if(double&&destination>0&&Math.abs(destination-1-target)<Math.abs(destination-target))landing--;
    const servesNow=destination===target||(double&&destination===target+1);
    const unknown=(stinky&&o[offset+5]<=0&&!servesNow)||(!servesNow&&!inZone(o,lift,landing,floors));
    let priorWeight=weights[landing],priorCount=counts[landing];
    if(double&&landing+1<=floors){priorWeight=add(priorWeight,weights[landing+1]);priorCount=add(priorCount,counts[landing+1]);}
    if(servesNow){priorWeight=currentWeight;priorCount=currentCount;}
    let eta=15;
    if(!unknown){
      const alight=add(mul(mul(door,scalar),priorWeight),div(add(priorCount,1),60));
      if(servesNow){
        const deliveryOpening=o[2665+lift*9]>0?add(closing,door):opening;
        eta=add(add(add(firstLeg,deliveryOpening),interval),alight);
      }else{
        const delay=add(firstLeg,service);
        eta=add(add(add(delay,travel(o,lift,target,landing,delay,floors)),door),mul(mul(door,scalar),nextLastWeight));
        eta=add(eta,alight);
      }
    }
    const firstTick=phase>0?sub(1,phase):0,ticks=eta>=firstTick?add(1,Math.floor(sub(eta,firstTick))):0;
    const projected=add(age,mul(rate,ticks));
    if(projected>pressure){pressure=projected;selectedAge=clamp(div(age,60),-1);selectedEta=clamp(div(eta,15));selectedRate=div(rate,2);}
    const weight=Math.max(0,mul(o[offset+3],3));
    if(servesNow||(stinky&&o[offset+5]<=0)){currentWeight=add(currentWeight,weight);currentCount++;}
    else{weights[destination]=add(weights[destination],weight);counts[destination]++;}
  }
  return [clamp(o[3156+lift*18]),selectedAge,selectedEta,div(criticalWeight,Math.max(1,totalWeight)),selectedRate,pressure];
}

function features(o,target,item,diversity){
  const family=Math.floor(item/3),count=ITEM_TARGET_COUNTS[item];
  if(count===20)return liftFeatures(o,target,family);
  if(count===30)return [clamp(o[31+target*7]),diversity[target],Number(target<mul(o[25],30)),clamp(o[36+target*7]),0];
  let load=0,hazard=-1,presence=0,context=0,timer=0;
  for(let lift=0;lift<20;lift++){
    const [l,h,p,c,t]=liftFeatures(o,lift,family);if(p<=0)continue;
    load=add(load,l);presence++;hazard=Math.max(hazard,h);context=Math.max(context,c);timer=Math.max(timer,t);
  }
  load=div(load,Math.max(1,presence));if(presence===0)hazard=0;presence=div(presence,20);
  if(item===8||family===8)for(let floor=0;floor<30;floor++){
    if(floor>=mul(o[25],30))continue;
    hazard=Math.max(hazard,family===2?o[36+floor*7]:diversity[floor]);
    context=Math.max(context,o[(family===2?34:36)+floor*7]);
  }
  let global=-1;
  if(family<=5)global=family===4?4129:family===5?4128:4124+family;
  else if(family===6||family===7)global=4124+family;
  if(global>=0)timer=Math.max(timer,clamp(o[global]));
  return [load,clamp(hazard,-1),presence,clamp(context),timer];
}

// No hidden simulation state is accepted: only the same observation and legal
// action mask passed to the neural policy, plus its two pre-item score snapshots.
export function buildItemInputs(o,original,postLegacy,mask,configuration){
  if(!(o instanceof Float32Array)||o.length!==19704||!o.every(Number.isFinite)||
     !(original instanceof Float32Array)||original.length!==1063||!original.every(Number.isFinite)||
     !(postLegacy instanceof Float32Array)||postLegacy.length!==1063||!postLegacy.every(Number.isFinite)||
     !(mask instanceof Int32Array)||mask.length!==1062||!mask.every(x=>x===0||x===1))throw Error('Invalid item feature inputs');
  const {enabled,bases,profiles,priors}=configuration;
  const diversity=new Float32Array(30),counts=new Int32Array(900);
  if(enabled[24]||enabled[26])for(let guest=0;guest<1024;guest++){
    const offset=4344+guest*15;if(o[offset]<=0)continue;
    const group=round(mul(o[offset],51))-1,destination=round(mul(o[offset+1],30))-1;
    if(group>=0&&group<30&&destination>=0&&destination<30)counts[group*30+destination]++;
  }
  for(let floor=0;floor<30;floor++)if(enabled[24]||(enabled[26]&&floor<mul(o[25],30))){
    let total=0,majority=0;for(let dest=0;dest<30;dest++){const n=counts[floor*30+dest];total+=n;majority=Math.max(majority,n);}
    if(total)diversity[floor]=div(total-majority,total);
  }
  const musak=Array.from({length:20},(_,lift)=>(enabled[6]&&(profiles[6]&1))||(enabled[7]&&(profiles[7]&1))?musakProfile(o,lift):[0,0,0,0,0,0]);
  let elapsed=o[4122];if(o[4123]>0)elapsed=add(elapsed,div(sub(o[4123],1),180));elapsed=clamp(elapsed);
  const inputs=new Float32Array(2272),scratch=new Float32Array(204);scratch.set(diversity);
  musak.forEach((values,lift)=>scratch.set(values,30+lift*6));
  for(let item=0;item<27;item++){
    if(!enabled[item])continue;
    const anchor=bases[item]?postLegacy:original,source=starts[item],count=ITEM_TARGET_COUNTS[item],noop=Boolean(profiles[item]&2);
    let normalizer=0,legal=0,peak=noop?f(-3.4028235e38):f(-1e30);
    const begin=noop?source:620,end=noop?source+count:1062;
    if(!noop||mask[620]){
      for(let action=begin;action<end;action++)if(mask[action]&&(noop||action<source||action>=source+count)){
        peak=Math.max(peak,anchor[action]);legal++;
      }
      if(legal){
        let total=0;
        for(let action=begin;action<end;action++)if(mask[action]&&(noop||action<source||action>=source+count))total=add(total,f(Math.exp(sub(anchor[action],peak))));
        const shifted=f(Math.log(total));
        normalizer=noop?clamp(add(div(sub(peak,anchor[620]),8),div(shifted,8)),-priors[item],priors[item]):add(peak,shifted);
      }
    }
    scratch[150+item*2]=normalizer;scratch[151+item*2]=noop?0:legal;
    for(let target=0;target<count;target++){
      let values;
      if((profiles[item]&1)&&item===6)values=musak[target].slice(0,5);
      else if((profiles[item]&1)&&item===7){
        values=[0,0,0,0,0];let highest=f(-1e30);
        for(let lift=0;lift<20;lift++)if(o[2842+lift]>0&&musak[lift][5]>highest){highest=musak[lift][5];values=musak[lift].slice(0,5);}
      }else{
        values=features(o,target,item,diversity);
        if((profiles[item]&1)&&item>=3&&item<=5)for(let lift=item===3?target:0;lift<(item===3?target+1:20);lift++){
          if(o[2842+lift]>0&&o[4135+lift*6]===0&&o[278+lift*69]>0)values[1]=Math.max(values[1],f(.05));
        }
      }
      const contrast=noop?normalizer:clamp(legal?div(sub(anchor[source+target],normalizer),8):0,-priors[item],priors[item]);
      inputs.set([...values,clamp(o[2415+item]),elapsed,contrast],(source-778+target)*8);
    }
  }
  return {inputs,scratch};
}
