// Retained item-use timing, identical to the evaluated policy. No shop planning.
const integer=(v,lo,hi)=>Number.isInteger(v)&&v>=lo&&v<=hi;
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
