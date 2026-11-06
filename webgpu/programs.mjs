// Qualified schema16 oldest-cargo, loaded-gravity-pickup and shop-stock programs.
// These transform policy scores only; they never modify game state or legality.
const shader=`
@group(0) @binding(0) var<storage,read> observations:array<f32>;
@group(0) @binding(1) var<storage,read> mask:array<i32>;
@group(0) @binding(2) var<storage,read> weights:array<f32>;
@group(0) @binding(3) var<storage,read_write> logits:array<f32>;
struct Options{double_deck:u32,done:u32,oldest:f32,loaded:f32,wrench:f32,other:f32,other_item:i32,padding:u32}
@group(0) @binding(4) var<uniform> options:Options;
@compute @workgroup_size(32)
fn raw(@builtin(global_invocation_id) id:vec3<u32>){
  let car=id.x;if(car>=20u||options.done!=0u||observations[2410]!=0.0){return;}
  let cars=u32(observations[26]*20.0+0.5);let floors=u32(observations[25]*30.0+0.5);
  let lb=271u+69u*car;let mb=3154u+18u*car;
  if(car>=cars||floors==0u||observations[2842u+car]<=0.0||observations[lb+2u]<=0.0||observations[mb+6u]>0.0){return;}
  let double_deck=(options.double_deck&(1u<<car))!=0u;
  let age=clamp(observations[2668u+9u*car],0.0,1.0);
  if(age<=0.0){return;}
  if(options.oldest!=0.0&&(!double_deck||observations[3090]>0.0)&&mask[car*31u+30u]!=0){
    for(var floor=0u;floor<floors;floor++){
      if(observations[lb+39u+floor]>0.0&&observations[lb+8u+floor]>0.0&&mask[car*31u+floor]!=0){
        logits[car*30u+floor]+=options.oldest*age;break;
      }
    }
  }
  if(options.loaded==0.0||double_deck||observations[3087]<=0.0||observations[3090]!=0.0||observations[mb+1u]!=observations[3091]){return;}
  var delivery=false;
  for(var floor=0u;floor<floors;floor++){delivery=delivery||(mask[car*31u+floor]!=0&&observations[lb+8u+floor]>0.0);}
  if(!delivery){return;}
  for(var floor=0u;floor<floors;floor++){
    if(mask[car*31u+floor]==0||observations[lb+8u+floor]>0.0||observations[3514u+car*30u+floor]<=0.0){continue;}
    let fb=31u+7u*floor;let free=max(0.0,1.0-observations[lb+2u]);
    let waiting=observations[fb]*10.0;let demand=waiting*free>0.0;
    var reward=weights[1]*observations[3514u+car*30u+floor]*10.0*free;
    if(demand){reward+=weights[2]*(1.0+observations[fb+5u])*min(1.0,waiting);reward+=weights[3]*observations[fb+3u]*10.0;}
    // Eligible VIP contribution is zero because this car is loaded.
    let delta=options.loaded*age*max(0.0,reward);
    if(delta!=0.0){logits[car*30u+floor]-=delta;}
  }
}
@compute @workgroup_size(32)
fn shop(@builtin(global_invocation_id) id:vec3<u32>){
  let item=id.x;if(item>=27u||options.done!=0u||observations[2410]==0.0||mask[750u+item]==0){return;}
  var strength=options.other;
  if(item==0u){strength=options.wrench;}
  else if(options.other_item!=-1&&i32(item)!=options.other_item){return;}
  let delta=-strength*observations[2415u+item];
  if(delta!=0.0){logits[750u+item]+=delta;}
}
`;

export class PolicyPrograms{
  static async create(device,weights){
    if(!(weights instanceof Float32Array)||weights.length!==372||!weights.every(Number.isFinite))throw Error('Invalid routing weights');
    const self=new PolicyPrograms();self.device=device;self.busy=false;
    self.buffers=[19704,1062,372,1063].map((n,i)=>device.createBuffer({size:n*4,
      usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|(i===3?GPUBufferUsage.COPY_SRC:0)}));
    self.options=device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    self.readback=device.createBuffer({size:1063*4,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(self.buffers[2],0,weights);
    const layout=device.createBindGroupLayout({entries:[...self.buffers.map((_,binding)=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:binding===3?'storage':'read-only-storage'}})),
      {binding:4,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}}]});
    self.group=device.createBindGroup({layout,entries:[...self.buffers,self.options].map((buffer,binding)=>({binding,resource:{buffer}}))});
    try{
      const module=device.createShaderModule({code:shader});
      const errors=(await module.getCompilationInfo()).messages.filter(e=>e.type==='error');
      if(errors.length)throw Error(errors.map(e=>`${e.lineNum}: ${e.message}`).join('\n'));
      const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]});
      self.pipelines=Object.fromEntries(await Promise.all(['raw','shop'].map(async entryPoint=>[entryPoint,await device.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint}})])));
      return self;
    }catch(error){self.destroy();throw error;}
  }
  async apply(stage,observations,mask,source,{doubleDeckMask=0,done=false,oldest=24,loaded=1,wrench=32,other=32,otherItem=3}={}){
    if(this.busy)throw Error('Policy programs busy');
    if(!['raw','shop'].includes(stage)||!(observations instanceof Float32Array)||observations.length!==19704||!observations.every(Number.isFinite)||
       !(mask instanceof Int32Array)||mask.length!==1062||!mask.every(x=>x===0||x===1)||
       !(source instanceof Float32Array)||source.length!==1063||!source.every(Number.isFinite)||
       !Number.isInteger(doubleDeckMask)||doubleDeckMask<0||doubleDeckMask>0xfffff||
       ![oldest,loaded,wrench,other].every(x=>Number.isFinite(x)&&x>=0)||loaded>1||
       !Number.isInteger(otherItem)||otherItem< -1||otherItem>26||otherItem===0)throw Error('Invalid policy program inputs');
    this.busy=true;
    try{
      this.device.queue.writeBuffer(this.buffers[0],0,observations);this.device.queue.writeBuffer(this.buffers[1],0,mask);this.device.queue.writeBuffer(this.buffers[3],0,source);
      const options=new ArrayBuffer(32),u=new Uint32Array(options),f=new Float32Array(options),i=new Int32Array(options);
      u[0]=doubleDeckMask;u[1]=Number(done);f.set([oldest,loaded,wrench,other],2);i[6]=otherItem;
      this.device.queue.writeBuffer(this.options,0,options);
      const encoder=this.device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(this.pipelines[stage]);pass.setBindGroup(0,this.group);pass.dispatchWorkgroups(1);pass.end();
      encoder.copyBufferToBuffer(this.buffers[3],0,this.readback,0,1063*4);this.device.queue.submit([encoder.finish()]);
      await this.readback.mapAsync(GPUMapMode.READ);const result=new Float32Array(this.readback.getMappedRange().slice(0));this.readback.unmap();return result;
    }finally{this.busy=false;}
  }
  destroy(){for(const buffer of [...this.buffers,this.options,this.readback])buffer.destroy();}
}
