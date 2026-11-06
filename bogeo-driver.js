'use strict';
async function startLiftViewer(){
 const config=window.bogeoPolicyConfig;if(!config)throw Error('Browser policy configuration unavailable');
 const framesPerAction=config.framesPerAction||15;
 const params=new URLSearchParams(location.search);
 // The headless shop facade suppresses this global. Preserve the real game renderer.
 const renderInventory = window.updateInventoryUI;
 const panel=document.createElement('div');panel.style='position:fixed;top:0;left:0;right:0;z-index:999999;background:#15222d;color:#eef6ff;padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;font:14px system-ui;border-bottom:2px solid #62ccab';
 panel.innerHTML='<b id="bogeo-policy">bogeo · live GPU policy</b><label>Round <select id="bogeo-round"></select></label><label>Credits <input id="bogeo-credits" type="number" value="8" min="0" max="1000000" style="width:75px"></label><label>Seed <input id="bogeo-seed" type="number" value="200000000" min="1" max="4294967295" style="width:115px"></label><button id="bogeo-start">Run round</button><button id="bogeo-campaign">Run campaign</button><label><input id="bogeo-retries" type="checkbox"> Allow retries</label><button id="bogeo-pause">Pause</button><button id="bogeo-stop" disabled>Stop</button><label>Speed <select id="bogeo-speed"><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option><option value="8">8×</option><option value="0">Max</option></select></label><span id="bogeo-status">Original game engine and artwork · manual lifts · 15 frames/action</span>';
 document.body.append(panel);document.body.style.paddingTop='62px';const select=document.getElementById('bogeo-round');for(let r=1;r<=25;r++)select.add(new Option(r,r));select.value=params.get('round')||'3';
 document.getElementById('bogeo-credits').value=params.get('credits')||'8';
 document.getElementById('bogeo-seed').value=params.get('seed')||'200000000';
 document.getElementById('bogeo-policy').textContent='bogeo · '+config.checkpoint+' · '+60/framesPerAction+' decisions/s';
 document.getElementById('bogeo-status').textContent='Original game engine and artwork · manual lifts · '+framesPerAction+' frames/action';
 let active=false,paused=false,campaign=false,allowRetries=false,totalRetries=0,env=null,step=0,round=3,openingCredits=8,campaignSeed=200000000,attempt=1,runId=0;
 const status=document.getElementById('bogeo-status'),startButton=document.getElementById('bogeo-start'),campaignButton=document.getElementById('bogeo-campaign'),stopButton=document.getElementById('bogeo-stop'),retryCheckbox=document.getElementById('bogeo-retries');
 async function request(packet){
  if(window.bogeoBrowserPolicy)return window.bogeoBrowserPolicy.request(packet);
  throw Error('Browser policy unavailable');
 }
 let detailFramePhase=0,detailStartTime=1000000,detailOpenFirstTick=Array(20).fill(0);
 const travelDirection=Array(20).fill(0),reversalAge=Array(20).fill(-1),servedSinceReversal=Array(20).fill(0);
 const frameDeliveries=Array(20).fill(0);
 function recordTravel(before){
  Registry.lifts.forEach((car,i)=>{
   if(reversalAge[i]>=0)reversalAge[i]=Math.min(3600,reversalAge[i]+1);
   const direction=Math.sign(car.pos-before[i]);
   if(direction){
    if(travelDirection[i]&&travelDirection[i]!==direction){reversalAge[i]=0;servedSinceReversal[i]=0;}
    travelDirection[i]=direction;
   }
   if(frameDeliveries[i])servedSinceReversal[i]=1;
  });
 }
 function enhanced(){const observation=Array.from(env.observe());if(observation.length!==2662)throw Error('Unexpected base observation size '+observation.length);
  const floors=Registry.floors.length,lifts=Registry.lifts;const dispatchOffset=27+4+30*8+20*69;
  // Party attendees remain in the game, but are not waiting for a pickup.
  // Re-encode affected queues without mutating the reference engine's state.
  for(let f=0;f<floors;f++){
   const guests=Registry.floors[f].waitingGuests||[];
   if(!guests.some(g=>g.isPartying))continue;
   const waiting=guests.filter(g=>!g.isPartying);
   let happy=0,annoyed=0,critical=0,vip=0,oldest=0;
   for(const g of waiting){
    const age=Math.max(0,Game.virtualTime-g.spawnTime);
    if(age<=20000)happy++;
    else if(age<=40000)annoyed++;
    else if(age<=60000)critical++;
    if(g.isVip)vip++;
    oldest=Math.max(oldest,age);
   }
   const current=lifts.length?Math.round(lifts[0].pos/Registry.floorHeight):0;
   const priority=Math.min(1,Math.max(0,(vip*1e7+critical*1e5+annoyed*1e4+oldest+waiting.length*250-Math.abs(f-current))/1e7));
   observation.splice(31+7*f,7,waiting.length/10,happy/10,annoyed/10,critical/10,vip/10,Math.min(1,oldest/60000),priority);
   for(let l=0;l<lifts.length;l++){
    if(lifts[l].passengers.length)continue; // Keep onboard drop-off demand.
    const distance=Math.abs(f-Math.round(lifts[l].pos/Registry.floorHeight));
    observation[dispatchOffset+l*30+f]=Math.min(2,Math.max(-1,(vip*1e7+critical*1e5+annoyed*1e4+oldest/1000+waiting.length*100-distance)/1e7));
   }
  }
  let best=0;
  for(let f=1;f<30;f++)if(observation[31+7*f+6]>observation[31+7*best+6])best=f;
  for(let f=0;f<30;f++)observation[31+7*30+f]=Number(f===best);
  for(let l=lifts.length;l<20;l++)observation.fill(0,dispatchOffset+l*30,dispatchOffset+(l+1)*30);
  for(let i=0;i<20;i++){const car=lifts[i];if(!car){observation.push(...Array(9).fill(0));continue;}const distance=Math.abs(car.pos-car.targetFloor*Registry.floorHeight),passengers=car.passengers||[],now=Game.virtualTime;const capacity=PowerUps.getLiftCapacity(i);let oldest=0,critical=0;for(const guest of passengers){const wait=Math.max(0,now-guest.spawnTime);oldest=Math.max(oldest,wait);if(wait>40000)critical++;}
   observation.push(Number(distance<.01&&['IDLE','DONE'].includes(car.state)&&car.jamTimer<=0),Number(distance>=.01),Number(car.state==='DOORS_OPENING'),Number(car.state==='DOORS_CLOSING'),['DOORS_OPENING','BOARDING','DOORS_CLOSING'].includes(car.state)?Math.min(1,Math.max(0,car.stateProgress||0)):0,Math.min(1,distance/(Math.max(1,floors-1)*Registry.floorHeight)),Math.min(1,oldest/60000),critical/Math.max(1,capacity),Math.max(0,capacity-(config.observationSize>=3082?Registry.getLiftWeight(car):passengers.length))/Math.max(1,capacity));
  }
  if(config.observationSize>=2862){
   for(let i=0;i<20;i++)observation.push(Number(i<lifts.length));
  }
  if(config.observationSize>=3002){
   for(let f=0;f<30;f++){
    let up=0,down=0,upAge=0,downAge=0;
    for(const guest of Registry.floors[f]?.waitingGuests||[]){
     if(guest.isPartying)continue;
     const age=Math.max(0,Game.virtualTime-guest.spawnTime);
     if(guest.dest>f){up++;upAge=Math.max(upAge,age);}
     else if(guest.dest<f){down++;downAge=Math.max(downAge,age);}
    }
    observation.push(up/10,down/10,Math.min(1,upAge/60000),Math.min(1,downAge/60000));
   }
   for(let i=0;i<20;i++)observation.push(lifts[i]?.sweepDirection||0);
  }
  if(config.observationSize>=3082){
   for(let f=0;f<30;f++){
    const floor=Registry.floors[f];
    observation.push(Number(Boolean(floor)&&f===Registry.gymFloor),
     (floor?.waitingGuests||[]).filter(g=>g.isGymBro&&!g.isPartying).length/10);
   }
   for(let i=0;i<20;i++){
    const car=lifts[i];
    observation.push(car?car.passengers.filter(g=>g.isGymBro).length/10:0);
    if(!car)continue;
    observation[271+69*i+2]=Registry.getLiftWeight(car)/Config.liftCapacity;
    observation[271+69*i+7]=Number(Registry.isLiftStinky(car));
   }
  }
  if(config.observationSize>=4114){
   const definition=window.getRoundDefinition(Registry.stats.round),system=Config.GAME_DATA.system;
   const event=name=>Number(window.isRoundEventEnabled(definition,name));
   const endurance=definition.objective==='ENDURANCE',elapsed=Registry.enduranceSeconds||0;
   const progress=Math.max(0,Math.min(1,(endurance?elapsed:Config.roundTime-Registry.stats.timeLeft)/Config.roundTime));
   const spawn=definition.spawnStart+(definition.spawnEnd-definition.spawnStart)*progress;
   const travel=Registry.capsuleMode?(Registry.capsuleTravelSecPerFloor||.2):Registry.counterweightEnabled?Config.liftSpeedSec:
    definition.floors<=system.shortBuildingMaxFloors?system.shortBuildingLiftSpeedSec:system.tallBuildingLiftSpeedSec;
   observation.push(event('roomService'),event('gym'),Number(endurance),elapsed/180,spawn/5,
    (definition.gravityScalar||0)/2,Number(Boolean(definition.zoningEnabled)),Number(Boolean(Registry.counterweightEnabled)),
    Number(Boolean(Registry.capsuleMode)),Config.liftCapacity/20,1/travel/5,lifts.filter(car=>car.openPlanTimer>0).length/20);
   for(let f=0;f<30;f++){
    const waiting=(Registry.floors[f]?.waitingGuests||[]).filter(g=>!g.isPartying);
    observation.push(waiting.filter(g=>g.isRoomService).length/10,
     waiting.reduce((sum,g)=>sum+(g.boardingWeight||(g.isRoomService?3:g.isGymBro?2:1)),0)/20);
   }
   const doorStates=['DOORS_OPENING','BOARDING','DOORS_CLOSING'];
   for(let i=0;i<20;i++){
    const car=lifts[i];if(!car){observation.push(...Array(18).fill(0));continue;}
    const capacity=PowerUps.getLiftCapacity(i),weight=Registry.getLiftWeight(car),passengers=car.passengers;
    const paired=Registry.counterweightEnabled&&Number.isInteger(car.counterweightPartner),partner=paired?lifts[car.counterweightPartner]:null;
    const gravity=(definition.gravityScalar||0)*(car.isDoubleDecker||car.doubleDeckerTimer>0?2:1);
    observation.push(passengers.filter(g=>g.isRoomService).length/10,capacity/20,weight/capacity,
     window.getGravitySpeedMultiplier(weight,capacity,gravity),(car.serviceLower||0)/Math.max(1,floors-1),
     (car.serviceUpper??floors-1)/Math.max(1,floors-1),partner?(car.counterweightPartner+1)/20:0,(partner?.jamTimer||0)/10,
     Number(Boolean(Registry.isCounterweightManualServiceLift?.(car))),(car.lastBoardingWeight||1)/3,
     (car.serviceBoarded||0)/Math.max(12,Config.liftCapacity*2),Number(Boolean(car.tardisExpiryExodus)),
     Number(car.openPlanTimer>0),passengers.filter(g=>g.isVip).length/10);
    const ready=[],counts=[];
    for(const neighbor of [lifts[i-1],lifts[i+1]]){
     const f=Math.round(car.pos/Registry.floorHeight);
     const linked=Boolean(neighbor&&(car.openPlanTimer>0||neighbor.openPlanTimer>0)&&doorStates.includes(car.state)&&
      doorStates.includes(neighbor.state)&&f===Math.round(neighbor.pos/Registry.floorHeight)&&
      Math.abs(car.pos-neighbor.pos)<system.lateralTolerance*Registry.floorHeight);
     ready.push(Number(linked));
     counts.push(linked?passengers.filter(g=>g.dest!==f&&Math.abs(neighbor.targetFloor-g.dest)<Math.abs(car.targetFloor-g.dest)&&
      window.canGuestBoardLift(neighbor,g,f,Registry.isLiftStinky(neighbor),PowerUps.getLiftCapacity(neighbor.id))).length/10:0);
    }
    observation.push(...ready,...counts);
   }
   for(let i=0;i<20;i++)for(let f=0;f<30;f++){
    const car=lifts[i],waiting=Registry.floors[f]?.waitingGuests||[];
    observation.push(car?waiting.filter(g=>window.canGuestBoardLift(car,g,f,Registry.isLiftStinky(car),PowerUps.getLiftCapacity(i))).length/10:0);
   }
  }
  if(config.observationSize===19644||config.observationSize===19704){
   const now=Game.virtualTime,timers=PowerUps.timers||{};
   observation.push(Number(Boolean(Registry.sunsetActive)),Number(Boolean(Registry.sunsetHasHappened)),
    Registry.sunsetActive?Math.max(0,Registry.sunsetEndTime-now)/90000:0,
    Number(Boolean(Registry.vipSpawned)),(Registry.vipStage||0)/3,
    0,0,0, // Reserved ABI columns: no absent VIP or future return schedule.
    (now-detailStartTime)/180000,detailFramePhase/60);
   for(const key of ['jamImmunity','stinkImmunity','globalAngerPause','globalTurbo','globalTardis','wideDoors','globalDoubleDecker','globalOpenPlan'])
    observation.push((timers[key]||0)/60);
   observation.push(Number(Boolean(Registry.gameActive)),(Registry.roundStats?.defenestrationsThisRound||0)/20);
   for(let i=0;i<20;i++){
    const car=lifts[i];if(!car){observation.push(...Array(6).fill(0));continue;}
    const stink=car.freshenerTimer>0||timers.stinkImmunity>0?-1:car.stinkTimer||0;
    observation.push((car.jamTimer||0)/20,stink/20,Number(Boolean(car.manualOverride)),
     ((car.serviceCycleId||0)&16383)/16384,Math.max(0,now-(car.lastAutomationTime||0))/60000,detailOpenFirstTick[i]);
   }
   for(let f=0;f<30;f++)observation.push((Registry.floors[f]?.boardingCursor||0)/20);
   if(config.observationSize===19704)for(let i=0;i<20;i++){
    observation.push(...(lifts[i]?[travelDirection[i],reversalAge[i]<0?-1:reversalAge[i]/3600,servedSinceReversal[i]]:[0,0,0]));
   }
   const guests=[];
   for(let f=0;f<floors;f++)for(const guest of Registry.floors[f].waitingGuests||[])guests.push([f,guest]);
   for(let i=0;i<lifts.length;i++)for(const guest of lifts[i].passengers||[])guests.push([30+i,guest]);
   if(guests.length>1024)throw Error('Passenger observation capacity exceeded');
   for(const [group,g] of guests){
    const previous=lifts[g.lastAlightedLiftId],cycle=(g.lastAlightedServiceCycle||0)&16383;
    const guarded=Boolean(previous&&cycle);
    observation.push((group+1)/51,(g.dest+1)/30,(now-g.spawnTime)/60000,
     (g.boardingWeight||(g.isRoomService?3:g.isGymBro?2:1))/3,
     Number(Boolean(g.isVip)),Number(Boolean(g.isGymBro)),Number(Boolean(g.isRoomService)),
     Number(Boolean(g.isFarter)),Number(Boolean(g.isSunset)),Number(Boolean(g.isPartying)),
     (g.dest+1)/30, // Legacy column aliases the visible, current destination.
     guarded?(g.lastAlightedLiftId+1)/20:0,guarded?(g.lastAlightedFloor+1)/30:0,
     Number(guarded&&cycle===((previous.serviceCycleId||0)&16383)),Number(Boolean(g.isCheckout)));
   }
   observation.push(...Array((1024-guests.length)*15).fill(0));
  }
  return observation;
 }
 const lastSwitch=Array(20).fill(-Infinity);
 function maskSwitchCooldown(mask){
  const duration=(config.switchCooldownFrames||0)*1000/60;
  for(let lift=0;lift<Registry.lifts.length;lift++){
   if(Game.virtualTime-lastSwitch[lift]>=duration)continue;
   for(let floor=0;floor<30;floor++){
    if(floor!==Registry.lifts[lift].targetFloor)mask[lift*30+floor]=0;
   }
  }
 }
 function dispatchFleet(targets,mask){
  if(!Array.isArray(targets)||targets.length!==20||targets.some(x=>!Number.isInteger(x)||x<0||x>30)){
   console.error('Invalid multi-lift targets',targets);
   throw Error('Invalid multi-lift targets');
  }
  const floors=Registry.floors.length;
  const before=Registry.lifts.map(car=>car.targetFloor);
  // Match fleet_dispatch: commands share one pre-step mask and one time advance.
  for(let lift=0;lift<Registry.lifts.length;lift++){
   const target=targets[lift],car=Registry.lifts[lift];
   if(target===30)continue;
   if(target>=floors)throw Error('Target outside building');
   const partner=Registry.counterweightEnabled?car.counterweightPartner:-1;
   if(Number.isInteger(partner)&&partner>=0&&partner<lift)throw Error('Duplicate paired-lift command');
   let commanded=lift,floor=target;
   if(!mask[commanded*30+floor]&&Number.isInteger(partner)&&partner>=0){
    commanded=partner;floor=floors-1-target;
   }
   if(!mask[commanded*30+floor])throw Error('Policy returned an illegal lift target');
   window.setLiftTarget(commanded,floor);
  }
  Registry.lifts.forEach((car,i)=>{if(car.targetFloor!==before[i])lastSwitch[i]=Game.virtualTime;});
 }
 function setRunning(running){
  active=running;startButton.disabled=running;campaignButton.disabled=running;stopButton.disabled=!running;retryCheckbox.disabled=running;
 }
 function isSuccess(transition){
  if(!transition.terminated||transition.truncated)return false;
  return round===12?Registry.stats.lives<=0:Registry.stats.timeLeft<=0&&Registry.stats.lives>0;
 }
 const originalAnimationTick=window.animationTick;
 window.animationTick=function(timestamp){
  if(config.observationSize!==19704||!Registry.gameActive)return originalAnimationTick(timestamp);
  const positions=Registry.lifts.map(car=>car.pos);
  frameDeliveries.fill(0);
  originalAnimationTick(timestamp);
  recordTravel(positions);
 };
 async function beginRound(token,restartShop=false){
  if(!restartShop)await request({reset:true,round,roundSeed:Game.Campaign.deriveRoundSeed(campaignSeed,round),credits:openingCredits});
  if(!active||token!==runId)return;
  const seed=Game.Campaign.deriveRoundSeed(campaignSeed,round),ui=window.UI;
  const options={seed,round,spaceFloors:30,spaceLifts:20,includeRound:true,richObservation:true,dispatchFeatures:true,fullControl:true,controlMode:'full',automationProfile:'manual',powerupBudget:0,shop:true,startingCredits:openingCredits,wideDoorsPurchaseLimit:-1,maxSeconds:round===12?3600:180,telemetry:false};
  env=window.bogeoWithShop(window,window.createLiftOperatorUpstreamEnv(options),options,'');
  // The adapter replaces Audio with its headless facade on reset. Observe the
  // engine's actual delivery event, including the correct lift for double decks.
  const publish=Game.Audio.publish;
  Game.Audio.publish=function(name,payload){
   if(name==='guest_served'&&Number.isInteger(payload?.liftId))frameDeliveries[payload.liftId]=1;
   return publish.call(this,name,payload);
  };
  window.updateInventoryUI=renderInventory;Game.UI=ui;
  Registry.debugSession=true; // Playback must not replace a saved player campaign.
  window.buildWorld();document.querySelectorAll('.overlay').forEach(x=>x.style.display='none');
  Registry.isPaused=false;Registry.gameActive=true;Game.isSimulating=false;
  const seedDisplay=document.getElementById('seedDisplay');
  if(seedDisplay)seedDisplay.textContent=String(Registry.seed);
  window.draw();window.updateScoreboardUI();window.updateInventoryUI();
  select.value=String(round);document.getElementById('bogeo-credits').value=String(openingCredits);
  lastSwitch.fill(-Infinity);
  travelDirection.fill(0);reversalAge.fill(-1);servedSinceReversal.fill(0);frameDeliveries.fill(0);
  detailFramePhase=0;detailStartTime=Game.virtualTime;detailOpenFirstTick.fill(0);
  step=0;status.textContent=`${campaign?'Campaign · ':''}Round ${round}${campaign?'/25':''} · attempt ${attempt} · ${openingCredits} opening credits`;
 }
 async function tick(token){
  if(!active||token!==runId)return;
  if(paused){setTimeout(()=>tick(token),100);return;}
  const began=performance.now();
  try{
   const obs=enhanced(),mask=Array.from(env.actionMask());
   if(config.manualRetarget&&obs[2410]<0.5){
    for(let lift=0;lift<Registry.lifts.length;lift++){
     const car=Registry.lifts[lift];
     for(let floor=0;floor<Registry.floors.length;floor++){
      mask[lift*30+floor]=Number(!Registry.isFloorInLiftZone||Registry.isFloorInLiftZone(car,floor));
     }
    }
   }
   if(config.allLifts&&obs[2410]<.5)maskSwitchCooldown(mask);
   let context;
   if(config.bundle){
    const timers=PowerUps.timers||{},cars=Registry.lifts;
    context=[Math.round((Game.virtualTime-detailStartTime)/1000),detailFramePhase,Registry.floors.length,cars.length,
     ...['jamImmunity','stinkImmunity','globalAngerPause','globalTurbo','globalTardis','wideDoors','globalDoubleDecker','globalOpenPlan'].map(key=>Math.round(timers[key]||0)),
     ...env.purchaseCounts(),
     ...Array.from({length:20},(_,i)=>Registry.counterweightEnabled&&Number.isInteger(cars[i]?.counterweightPartner)?cars[i].counterweightPartner:-1),
     ...Array.from({length:20},(_,i)=>Number(Boolean(cars[i]?.isDoubleDecker)))];
   }
   const result=await request({observation:obs,mask,context});
   if(!active||token!==runId)return;
   if(result.restartShop){
    await beginRound(token,true);
    if(active&&token===runId)setTimeout(()=>tick(token),0);
    return;
   }
   if(!Number.isInteger(result.action)||!mask[result.action])throw Error('Policy returned an illegal action');
   const openBefore=Registry.lifts.map(car=>car.openPlanTimer||0);
   if(config.allLifts&&obs[2410]<.5)dispatchFleet(result.lifts,mask);
   const transition=env.step(result.action);step++;
   if(obs[2410]<.5){
    if(detailFramePhase===0)detailOpenFirstTick.fill(0);
    else Registry.lifts.forEach((car,i)=>{if((car.openPlanTimer||0)>openBefore[i])detailOpenFirstTick[i]=1;});
    detailFramePhase=(detailFramePhase+framesPerAction)%60;
   }
   window.draw();window.updateScoreboardUI();window.updateInventoryUI?.();
   status.textContent=`${campaign?`Campaign · round ${round}/25 · attempt ${attempt} · `:''}Decision ${step} · ${config.allLifts?'all lifts · global ':''}action ${result.action} · ${Registry.stats.timeLeft}s left · ${Registry.stats.lives} lives · ${Registry.points} credits`;
   if(transition.terminated||transition.truncated){
    const success=isSuccess(transition);
    if(!campaign||success&&round===25){
     setRunning(false);
     status.textContent=campaign?`Campaign complete · 25/25 rounds · ${totalRetries?`${totalRetries} ${totalRetries===1?'retry':'retries'}`:'no retries'} · ${Registry.points} closing credits`:`Round ${round} ${success?'survived':'failed'} · ${Registry.points} closing credits`;
     return;
    }
    if(!success&&!allowRetries){
     setRunning(false);
     status.textContent=`Campaign failed at round ${round}; completed ${round-1}/25; no retries`;
     return;
    }
    if(success){openingCredits=Registry.points;round++;attempt=1;}
    else {attempt++;totalRetries++;} // Retry with the same seed and pre-round balance.
    await beginRound(token);
    if(active&&token===runId)setTimeout(()=>tick(token),0);
    return;
   }
   const speed=Number(document.getElementById('bogeo-speed').value);
   setTimeout(()=>tick(token),Math.max(0,(speed?1000*framesPerAction/60/speed:0)-(performance.now()-began)));
  }catch(e){
   if(token!==runId)return;
   setRunning(false);status.textContent='Stopped: '+e.message;console.error(e);
  }
 }
 async function start(asCampaign){
  if(active)return;
  try{
   const seed=Number(document.getElementById('bogeo-seed').value);
   if(!Number.isInteger(seed)||seed<1||seed>4294967295)throw Error('Seed must be an integer from 1 to 4294967295');
   const credits=Number(document.getElementById('bogeo-credits').value);
   if(!asCampaign&&(!Number.isInteger(credits)||credits<0||credits>1000000))throw Error('Credits must be 0–1000000');
   campaign=asCampaign;allowRetries=asCampaign&&retryCheckbox.checked;totalRetries=0;campaignSeed=seed;round=asCampaign?1:Number(select.value);
   openingCredits=asCampaign?0:credits;attempt=1;paused=false;
   document.getElementById('bogeo-pause').textContent='Pause';
   setRunning(true);const token=++runId;
   await beginRound(token);
   if(active&&token===runId)tick(token);
  }catch(e){setRunning(false);status.textContent='Stopped: '+e.message;console.error(e);}
 }
 startButton.onclick=()=>start(false);
 campaignButton.onclick=()=>start(true);
 document.getElementById('bogeo-pause').onclick=()=>{if(!active)return;paused=!paused;document.getElementById('bogeo-pause').textContent=paused?'Resume':'Pause';};
 stopButton.onclick=()=>{if(!active)return;runId++;setRunning(false);status.textContent=`Stopped by user · round ${round} · attempt ${attempt}`;};
}
if(document.readyState==='loading')window.addEventListener('DOMContentLoaded',startLiftViewer);
else startLiftViewer();
