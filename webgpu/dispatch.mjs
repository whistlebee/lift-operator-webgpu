// Saved ordinary/coupled floor scoring. All decisions use current public state.
const shader=`
@group(0) @binding(0) var<storage,read> obs:array<f32>;
@group(0) @binding(1) var<storage,read> logits:array<f32>;
@group(0) @binding(2) var<storage,read> mask:array<i32>;
@group(0) @binding(3) var<storage,read> weights:array<f32>;
@group(0) @binding(4) var<storage,read_write> choices:array<i32>;
struct Options{done:u32,shop:u32,decks:u32,adaptive:u32}
@group(0) @binding(5) var<uniform> options:Options;
fn deck(car:i32)->bool{return (options.decks&(1u<<u32(car)))!=0u;}
fn waiting()->vec3<i32>{
  for(var slot=0;slot<1024;slot++){
    let b=4344+15*slot;let floor=i32(obs[b]*51.0+0.5)-1;
    if(floor<0||floor>=30){break;}if(obs[b+4]==0.0){continue;}
    var blocked=-1;if(obs[b+13]!=0.0&&i32(obs[b+12]*30.0+0.5)-1==floor){blocked=i32(obs[b+11]*20.0+0.5)-1;}
    return vec3<i32>(floor,i32(obs[b+1]*30.0+0.5)-1,blocked);
  }return vec3<i32>(-1);
}
fn collect(car:i32,v:vec3<i32>,floors:i32)->bool{
  let b=271+69*car;
  if(car==v.z||obs[b+2]!=0.0||obs[b+7]!=0.0||obs[3514+30*car+v.x]<=0.0){return false;}
  let lower=i32(obs[3158+18*car]*f32(floors-1)+0.5);let upper=i32(obs[3159+18*car]*f32(floors-1)+0.5);
  return (v.x==0||(v.x>=lower&&v.x<=upper))&&(v.y==0||(v.y>=lower&&v.y<=upper));
}
fn cargo_reference(root:i32,floors:i32,pickup:i32)->i32{
  let odd=root+1;
  if(obs[2842+root]<=0.0||obs[2842+odd]<=0.0||i32(obs[3160+18*root]*20.0+0.5)-1!=odd||i32(obs[3160+18*odd]*20.0+0.5)-1!=root||deck(root)||deck(odd)){return pickup;}
  if(pickup<0||pickup>=floors||mask[31*root+pickup]==0){return pickup;}
  let other=floors-1-pickup;
  if(obs[279+69*root+pickup]>0.0||obs[279+69*odd+other]>0.0||(obs[3514+30*root+pickup]<=0.0&&obs[3514+30*odd+other]<=0.0)){return pickup;}
  var best=-1;var best_oldest=false;var best_score=-bitcast<f32>(0x7f7fffffu);
  for(var floor=0;floor<floors;floor++){
    if(mask[31*root+floor]==0){continue;}var eligible=false;var oldest=false;
    for(var side=0;side<2;side++){
      let car=root+side;let dest=select(floors-1-floor,floor,side==0);let b=271+69*car;
      if(obs[2668+9*car]>=40.0/60.0&&obs[b+8+dest]>0.0){eligible=true;oldest=oldest||obs[b+39+dest]>0.0;}
    }
    let score=logits[31*root+floor];
    if(eligible&&(best<0||(oldest&&!best_oldest)||(oldest==best_oldest&&score>best_score))){best=floor;best_oldest=oldest;best_score=score;}
  }
  return select(pickup,best,best>=0);
}
@compute @workgroup_size(32)
fn rank(@builtin(global_invocation_id) id:vec3<u32>){
  let adaptive=options.adaptive!=0u;let lane=i32(id.x);if(lane>=select(4,20,adaptive)){return;}
  let root=select(2*lane,lane,adaptive);
  if(options.done!=0u||options.shop!=0u||obs[2842+root]<=0.0||deck(root)){return;}
  let partner=i32(obs[3160+18*root]*20.0+0.5)-1;
  if(!adaptive&&(obs[22]==0.0||partner!=root+1)){return;}
  if(adaptive&&(obs[22]!=0.0||obs[24]!=0.0)){return;}
  if(partner>=0){
    if(partner!=root+1||partner>=20||obs[2842+partner]<=0.0||i32(obs[3160+18*partner]*20.0+0.5)!=root+1||deck(partner)){return;}
  }
  let floors=i32(obs[25]*30.0+0.5);var reference=choices[root];
  if(!adaptive){reference=cargo_reference(root,floors,reference);}
  let b=271+69*root;let position=obs[b]*f32(floors-1);let destination=i32(obs[b+1]*f32(floors-1)+0.5);
  var vip=vec3<i32>(-1);var pickup_weight=0.0;var dropoff_weight=0.0;
  if(!adaptive||obs[13]!=0.0){pickup_weight=weights[16];dropoff_weight=weights[17];if(pickup_weight!=0.0&&obs[4117]!=0.0){vip=waiting();}}
  var best=reference;var best_score=-3.4e38;
  for(var action=0;action<31;action++){
    if(mask[31*root+action]==0){continue;}let hold=action==30;let floor=select(action,destination,hold);
    if(floor<0||floor>=floors){continue;}var x:array<f32,16>;var vip_score=0.0;
    let distance=abs(f32(floor)-position)/f32(floors-1);
    for(var side=0;side<select(1,2,partner>=0);side++){
      let car=root+side;let dest=select(floors-1-floor,floor,side==0);let cb=271+69*car;
      let cargo=obs[cb+8+dest];let oldest=obs[cb+39+dest];let age=obs[2668+9*car];
      let queue=min(2.0,obs[3514+30*car+dest]*5.0);let pickup=select(0.0,1.0,queue>0.0);let onboard=select(0.0,1.0,cargo>0.0);
      if(pickup_weight!=0.0||dropoff_weight!=0.0){
        if(onboard!=0.0&&obs[3167+18*car]>0.0){vip_score+=dropoff_weight;}
        if(dest==vip.x&&collect(car,vip,floors)){vip_score+=pickup_weight/(1.0+4.0*distance);}
      }
      x[0]+=onboard;x[1]+=min(2.0,4.0*cargo);x[2]+=oldest;x[3]+=oldest*age;x[4]+=pickup;x[5]+=queue;x[6]+=pickup*obs[31+7*dest+5];x[7]+=pickup*age;
    }
    if(action!=reference&&!hold&&x[0]==0.0&&x[4]==0.0){continue;}
    x[8]=distance;x[9]=distance*x[0];x[10]=distance*x[4];x[11]=select(0.0,1.0,floor==destination);x[12]=select(0.0,1.0,hold);
    x[13]=select(0.0,1.0,x[0]>0.0&&x[4]>0.0);x[14]=select(0.0,1.0,x[0]==2.0||x[4]==2.0);
    if(adaptive&&partner<0){x[14]=x[5]*obs[b+2];}
    x[15]=select(0.0,1.0,floor==destination&&obs[2663+9*root]>0.0);
    var score=select(0.0,1.0,action==reference);for(var j=0;j<16;j++){score+=weights[j]*x[j];}score+=vip_score;
    if(score>best_score||(score==best_score&&action==reference)){best_score=score;best=action;}
  }
  choices[root]=best;
}
`;

export function dispatchConfiguration(model){
  const adaptive=model.round!==23,weights=model.weights;
  if(model.schema!==1||!Number.isInteger(model.round)||model.round<1||model.round>25||
    model.kind!==(adaptive?'manual_dispatch_residual':'coupled_dispatch_residual')||
    !Array.isArray(weights)||![16,18].includes(weights.length)||(!adaptive&&weights.length!==18)||!weights.every(Number.isFinite))throw Error('Unsupported dispatch model');
  for(const k of ['vip_pickup_pairs','vip_staging_seconds','vip_pair_eta','overdue_seconds'])if((model[k]??0)!==0)throw Error(`Unported dispatch option: ${k}`);
  if(![0,1].includes(model.redirect_empty_vip??0)||model.redirect_empty_vip&&model.round!==14||model.responder_weights)throw Error('Unsupported VIP responder');
  if(![0,1].includes(model.vip_empty_departures??0)||model.vip_empty_departures&&model.round!==8)throw Error('VIP empty departures supported only for round 8');
  return {vipEmptyDepartures:!!model.vip_empty_departures,adaptive,redirectVip:!!model.redirect_empty_vip,weights:Float32Array.from([...weights,...Array(18-weights.length).fill(0)])};
}
export class FloorDispatch{
  static async create(device){
    const self=new FloorDispatch();self.device=device;self.busy=false;
    self.buffers=[19704,1063,1062,18,21].map((n,i)=>device.createBuffer({size:n*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|(i===4?GPUBufferUsage.COPY_SRC:0)}));
    self.options=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});self.readback=device.createBuffer({size:84,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
    const layout=device.createBindGroupLayout({entries:[...self.buffers.map((_,binding)=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:binding===4?'storage':'read-only-storage'}})),{binding:5,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}}]});
    self.group=device.createBindGroup({layout,entries:[...self.buffers,self.options].map((buffer,binding)=>({binding,resource:{buffer}}))});
    try{
      const module=device.createShaderModule({code:shader});const errors=(await module.getCompilationInfo()).messages.filter(e=>e.type==='error');
      if(errors.length)throw Error(errors.map(e=>`${e.lineNum}: ${e.message}`).join('\n'));
      self.pipeline=await device.createComputePipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[layout]}),compute:{module,entryPoint:'rank'}});return self;
    }catch(e){self.destroy();throw e;}
  }
  async apply(model,obs,logits,mask,choices,{done=false,shop=false,doubleDeckMask=0}={}){
    if(this.busy)throw Error('Floor dispatcher busy');const config=dispatchConfiguration(model);
    if(!(obs instanceof Float32Array)||obs.length!==19704||!obs.every(Number.isFinite)||
       !(logits instanceof Float32Array)||logits.length!==1063||!logits.every(Number.isFinite)||
       !(mask instanceof Int32Array)||mask.length!==1062||!mask.every(n=>n===0||n===1)||
       !(choices instanceof Int32Array)||choices.length!==21||!choices.every((n,i)=>n>=0&&n<(i<20?31:442))||
       ![false,true,0,1].includes(done)||![false,true,0,1].includes(shop)||!Number.isInteger(doubleDeckMask)||doubleDeckMask<0||doubleDeckMask>0xfffff)throw Error('Invalid dispatch inputs');
    this.busy=true;
    try{
      [obs,logits,mask,config.weights,choices].forEach((data,i)=>this.device.queue.writeBuffer(this.buffers[i],0,data));
      this.device.queue.writeBuffer(this.options,0,new Uint32Array([Number(done),Number(shop),doubleDeckMask,Number(config.adaptive)]));
      const encoder=this.device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.group);pass.dispatchWorkgroups(1);pass.end();
      encoder.copyBufferToBuffer(this.buffers[4],0,this.readback,0,84);this.device.queue.submit([encoder.finish()]);await this.readback.mapAsync(GPUMapMode.READ);
      const result=new Int32Array(this.readback.getMappedRange().slice(0));this.readback.unmap();return result;
    }finally{this.busy=false;}
  }
  destroy(){for(const b of [...this.buffers,this.options,this.readback])b.destroy();}
}
