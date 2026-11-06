// Pack native decoder scores into twenty floor/hold heads and one item head.
// Game legality is supplied by the engine. Optional service observations apply
// the qualified policy's additional service protection before packing.
const shader=`
@group(0) @binding(0) var<storage,read> source:array<f32>;
@group(0) @binding(1) var<storage,read_write> legal:array<i32>;
@group(0) @binding(2) var<storage,read> partners:array<i32>;
@group(0) @binding(3) var<storage,read_write> mask:array<i32>;
@group(0) @binding(4) var<storage,read_write> logits:array<f32>;
struct Options{floors:u32,lifts:u32,done:u32,pair_floors:u32,temperature:f32,integrated_shop:u32,service:u32,vip_departures:u32}
@group(0) @binding(5) var<uniform> options:Options;
@group(0) @binding(6) var<storage,read> observations:array<f32>;
fn visible_vip_departure(car:i32)->i32{
  let b=271+69*car;
  if(observations[7]==0.0||observations[4117]==0.0||observations[2842+car]==0.0||observations[b+2]!=0.0||observations[b+6]!=0.0||observations[b+7]!=0.0||observations[3160+18*car]!=0.0){return -1;}
  let floors=i32(observations[25]*30.0+0.5);let destination=i32(observations[b+1]*f32(floors-1)+0.5);
  for(var slot=0;slot<1024;slot++){
    let r=4344+15*slot;let origin=i32(observations[r]*51.0+0.5)-1;
    if(origin<0||origin>=floors){break;}if(observations[r+4]==0.0){continue;}
    if(origin==destination||observations[3514+30*car+origin]<=0.0){return -1;}
    if(observations[r+13]!=0.0&&i32(observations[r+12]*30.0+0.5)-1==origin&&i32(observations[r+11]*20.0+0.5)-1==car){return -1;}
    let dest=i32(observations[r+1]*30.0+0.5)-1;let lo=i32(observations[3158+18*car]*f32(floors-1)+0.5);let hi=i32(observations[3159+18*car]*f32(floors-1)+0.5);
    if(dest>=0&&dest<floors&&(origin==0||(lo<=origin&&origin<=hi))&&(dest==0||(lo<=dest&&dest<=hi))){return origin;}
    return -1;
  }return -1;
}
@compute @workgroup_size(32)
fn service_mask(@builtin(global_invocation_id) id:vec3<u32>){
  let lift=id.x;if(lift>=20u||options.service==0u||legal[600]==0){return;}
  let active_count=u32(observations[26]*20.0+0.5);if(lift>=active_count){return;}
  let paired=observations[20]!=0.0||observations[21]!=0.0||observations[22]!=0.0;
  var busy=false;
  for(var side=0u;side<2u;side++){
    var car=lift;if(side==1u){if(!paired){break;}car=lift^1u;if(car>=active_count){break;}}
    let legacy=271u+car*69u;let enhanced=2662u+car*9u;
    busy=busy||observations[legacy+5u]!=0.0||observations[enhanced+2u]!=0.0||observations[enhanced+3u]!=0.0;
  }
  if(busy){var vip=-1;if(options.vip_departures!=0u){vip=visible_vip_departure(i32(lift));}
    for(var floor=0u;floor<30u;floor++){if(i32(floor)!=vip){legal[lift*30u+floor]=0;}}}
}
fn source_index(action:u32)->u32{
  if(action<620u){let lift=action/31u;let floor=action%31u;if(floor==30u){return 601u+lift;}return lift*30u+floor;}
  if(action==620u){return 600u;}return action;
}
@compute @workgroup_size(64)
fn pack(@builtin(global_invocation_id) id:vec3<u32>){
  let action=id.x;if(action>=1063u){return;}
  logits[action]=source[source_index(action)];if(action==1062u){return;}
  var allowed=0i;
  if(action<620u){
    let lift=action/31u;let floor=action%31u;
    if(floor==30u){allowed=1;}
    else if(lift<options.lifts&&floor<options.floors&&legal[777]==0&&options.done==0u){
      let partner=partners[lift];
      if(partner<0||partner>i32(lift)){
        allowed=legal[lift*30u+floor];
        if(partner>=0){allowed=max(allowed,legal[u32(partner)*30u+options.floors-1u-floor]);}
      }
    }
  }else if(options.done!=0u){allowed=select(0i,1i,action==620u);}
  else if(action==620u||action>=750u){allowed=legal[source_index(action)];}
  mask[action]=allowed;
}
@compute @workgroup_size(32)
fn normalize(@builtin(global_invocation_id) id:vec3<u32>){
  let lift=id.x;if(lift>=20u){return;}let offset=lift*31u;
  var peak=-1e30;var count=0u;
  for(var floor=0u;floor<30u;floor++){
    if(mask[offset+floor]==0){continue;}
    var score=source[lift*30u+floor];
    if(options.pair_floors>0u&&lift%2u==0u&&floor<options.pair_floors){
      score+=source[(lift+1u)*30u+options.pair_floors-1u-floor];
    }
    if(options.temperature!=1.0){score/=options.temperature;}
    logits[offset+floor]=score;peak=max(peak,score);count++;
  }
  if(count==0u){return;}var total=0.0;
  for(var floor=0u;floor<30u;floor++){if(mask[offset+floor]!=0){total+=exp(logits[offset+floor]-peak);}}
  let normalizer=peak+log(total);
  for(var floor=0u;floor<30u;floor++){if(mask[offset+floor]!=0){logits[offset+floor]-=normalizer;}}
  logits[offset+30u]-=source[777];
}
@compute @workgroup_size(1)
fn global_head(){
  if(mask[620]!=0){let wait=source[600];let dispatch=source[777];let peak=max(wait,dispatch);
    logits[620]=peak+log(exp(wait-peak)+exp(dispatch-peak));}
  if(options.integrated_shop!=0u&&mask[777]!=0){logits[777]=source[621];}
}
`;

export class FleetTransform{
  static async create(device){
    const self=new FleetTransform();self.device=device;self.busy=false;
    self.buffers=[1063,1062,20,1062,1063].map((n,i)=>device.createBuffer({size:n*4,
      usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|(i>=3?GPUBufferUsage.COPY_SRC:0)}));
    self.options=device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    self.observations=device.createBuffer({size:19704*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    self.readback=device.createBuffer({size:(1062+1063)*4,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
    const layout=device.createBindGroupLayout({entries:[...self.buffers.map((_,binding)=>({binding,
      visibility:GPUShaderStage.COMPUTE,buffer:{type:binding===1||binding>=3?'storage':'read-only-storage'}})),
      {binding:5,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}},
      {binding:6,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}}]});
    self.group=device.createBindGroup({layout,entries:[...self.buffers,self.options,self.observations].map((buffer,binding)=>({binding,resource:{buffer}}))});
    try{
      const module=device.createShaderModule({code:shader});
      const errors=(await module.getCompilationInfo()).messages.filter(e=>e.type==='error');
      if(errors.length)throw Error(errors.map(e=>`${e.lineNum}: ${e.message}`).join('\n'));
      const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]});
      self.pipelines=await Promise.all(['service_mask','pack','normalize','global_head'].map(entryPoint=>device.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint}})));
      return self;
    }catch(error){self.destroy();throw error;}
  }
  async transform(source,legal,partners,{floors,lifts,done=false,pairFloors=0,temperature=1,integratedShop=true,serviceObservation=null,vipEmptyDepartures=false}){
    if(this.busy)throw Error('Fleet transform busy');
    if(!(source instanceof Float32Array)||source.length!==1063||!source.every(Number.isFinite)||
       !(legal instanceof Int32Array)||legal.length!==1062||!legal.every(x=>x===0||x===1)||
       !(partners instanceof Int32Array)||partners.length!==20||!partners.every(x=>x>=-1&&x<20)||
       !Number.isInteger(floors)||floors<1||floors>30||!Number.isInteger(lifts)||lifts<1||lifts>20||
       ![0,11,15,29].includes(pairFloors)||!Number.isFinite(temperature)||temperature<=0||
       (serviceObservation!==null&&(!(serviceObservation instanceof Float32Array)||serviceObservation.length!==19704||!serviceObservation.every(Number.isFinite))))throw Error('Invalid fleet transform inputs');
    if(typeof vipEmptyDepartures!=='boolean'||vipEmptyDepartures&&serviceObservation===null)throw Error('VIP departures require service observations');
    this.busy=true;
    try{
      [source,legal,partners].forEach((data,i)=>this.device.queue.writeBuffer(this.buffers[i],0,data));
      const options=new ArrayBuffer(32),ints=new Uint32Array(options),floats=new Float32Array(options);
      ints.set([floors,lifts,Number(done),pairFloors]);floats[4]=temperature;ints[5]=Number(integratedShop);ints[6]=Number(serviceObservation!==null);ints[7]=Number(vipEmptyDepartures);
      this.device.queue.writeBuffer(this.options,0,options);
      if(serviceObservation!==null)this.device.queue.writeBuffer(this.observations,0,serviceObservation);
      const encoder=this.device.createCommandEncoder();
      this.pipelines.forEach((pipeline,i)=>{const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,this.group);pass.dispatchWorkgroups(i===1?17:1);pass.end();});
      encoder.copyBufferToBuffer(this.buffers[3],0,this.readback,0,1062*4);
      encoder.copyBufferToBuffer(this.buffers[4],0,this.readback,1062*4,1063*4);
      this.device.queue.submit([encoder.finish()]);await this.readback.mapAsync(GPUMapMode.READ);
      const bytes=this.readback.getMappedRange().slice(0);this.readback.unmap();
      return {mask:new Int32Array(bytes,0,1062),logits:new Float32Array(bytes,1062*4,1063)};
    }finally{this.busy=false;}
  }
  destroy(){for(const buffer of [...this.buffers,this.options,this.observations,this.readback])buffer.destroy();}
}
