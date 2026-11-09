// The 27 item networks operate on eight public-state features per target.
// Feature construction is separate; this module evaluates the saved networks.
const counts=Array.from({length:27},(_,item)=>{
  const family=Math.floor(item/3),tier=item%3;
  if(tier===2)return 1;
  if(family===8)return tier===0?30:20;
  return tier===0||[3,6,7].includes(family)?20:1;
});
export const ITEM_TARGET_COUNTS=Object.freeze(counts);
const shader=`
@group(0) @binding(0) var<storage,read> weights:array<f32>;
@group(0) @binding(1) var<storage,read> inputs:array<f32>;
@group(0) @binding(2) var<storage,read> enabled:array<i32>;
@group(0) @binding(3) var<storage,read> base:array<f32>;
@group(0) @binding(4) var<storage,read_write> result:array<f32>;
const counts=array<u32,27>(${counts.map(n=>n+'u').join(',')});
@compute @workgroup_size(64)
fn forward(@builtin(global_invocation_id) id:vec3<u32>){
  let sample=id.x;if(sample>=284u){return;}
  var index=sample;var item=0u;
  loop{if(index<counts[item]||item==26u){break;}index-=counts[item];item++;}
  var output=0.0;
  for(var channel=0u;channel<8u;channel++){
    var value=0.0;
    if(enabled[item]!=0){let start=item*81u+channel*9u;value=weights[start+8u];
      for(var feature=0u;feature<8u;feature++){value+=weights[start+feature]*inputs[sample*8u+feature];}
      value=max(0.0,value);}
    result[sample*8u+channel]=value;
  }
  if(enabled[item]!=0){output=weights[item*81u+80u];
    for(var channel=0u;channel<8u;channel++){output+=weights[item*81u+72u+channel]*result[sample*8u+channel];}}
  result[2272u+sample]=output;
}
@compute @workgroup_size(64)
fn combine(@builtin(global_invocation_id) id:vec3<u32>){
  let action=id.x;if(action>=1063u){return;}var value=base[action];
  if(action>=778u&&action<1062u){let delta=result[2272u+action-778u];if(delta!=0.0){value+=delta;}}
  result[2556u+action]=value;
}
`;

export class ItemBank{
  static async create(device,bytes,metadata){
    const sizes=Array.from({length:54},(_,i)=>i%2?9:72),offsets=Array.from({length:54},(_,i)=>Math.floor(i/2)*88+(i%2?72:0));
    if(metadata.schema_version!==1||metadata.format!=='pufferlib.flat_float32'||metadata.dtype!=='float32'||metadata.endianness!=='little'||
       JSON.stringify(metadata.parameter_sizes)!==JSON.stringify(sizes)||JSON.stringify(metadata.parameter_offsets)!==JSON.stringify(offsets)||bytes.byteLength!==2376*4)throw Error('Unsupported item checkpoint');
    const padded=new Float32Array(bytes),packed=new Float32Array(2187);
    for(let item=0;item<27;item++)packed.set(padded.subarray(item*88,item*88+81),item*81);
    if(!packed.every(Number.isFinite))throw Error('Nonfinite item weights');
    const self=new ItemBank();self.device=device;self.busy=false;
    self.buffers=[2187,2272,27,1063,3619].map((n,i)=>device.createBuffer({size:n*4,
      usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|(i===4?GPUBufferUsage.COPY_SRC:0)}));
    self.readback=device.createBuffer({size:3619*4,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(self.buffers[0],0,packed);
    const layout=device.createBindGroupLayout({entries:self.buffers.map((_,binding)=>({binding,
      visibility:GPUShaderStage.COMPUTE,buffer:{type:binding===4?'storage':'read-only-storage'}}))});
    self.group=device.createBindGroup({layout,entries:self.buffers.map((buffer,binding)=>({binding,resource:{buffer}}))});
    try{
      const module=device.createShaderModule({code:shader});
      const errors=(await module.getCompilationInfo()).messages.filter(e=>e.type==='error');
      if(errors.length)throw Error(errors.map(e=>`${e.lineNum}: ${e.message}`).join('\n'));
      const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]});
      self.pipelines=await Promise.all(['forward','combine'].map(entryPoint=>device.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint}})));
      return self;
    }catch(error){self.destroy();throw error;}
  }
  async forward(inputs,enabled,base){
    if(this.busy)throw Error('Item bank busy');
    if(!(inputs instanceof Float32Array)||inputs.length!==2272||!inputs.every(Number.isFinite)||
       !(enabled instanceof Int32Array)||enabled.length!==27||!enabled.every(x=>x===0||x===1)||
       !(base instanceof Float32Array)||base.length!==1063||!base.every(Number.isFinite))throw Error('Invalid item bank inputs');
    this.busy=true;
    try{
      [inputs,enabled,base].forEach((data,i)=>this.device.queue.writeBuffer(this.buffers[i+1],0,data));
      const encoder=this.device.createCommandEncoder();
      this.pipelines.forEach((pipeline,i)=>{const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,this.group);pass.dispatchWorkgroups(i===0?5:17);pass.end();});
      encoder.copyBufferToBuffer(this.buffers[4],0,this.readback,0,3619*4);this.device.queue.submit([encoder.finish()]);
      await this.readback.mapAsync(GPUMapMode.READ);const values=new Float32Array(this.readback.getMappedRange().slice(0));this.readback.unmap();
      return {hidden:values.slice(0,2272),residual:values.slice(2272,2556),logits:values.slice(2556)};
    }finally{this.busy=false;}
  }
  destroy(){for(const buffer of [...this.buffers,this.readback])buffer.destroy();}
}
