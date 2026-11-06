// Philox4x32-10 with the exact std.random.Random.step_uniform conversion.
// Algorithm reference: Modular's Mojo/stdlib/std/random/philox.mojo.
// Explicit BigInt arithmetic avoids loss of UInt64 seed/offset bits in JS.
const U32=0xffffffffn, U64=0xffffffffffffffffn, f32=Math.fround;
export function philoxUniform(seed,offset){
  seed=BigInt(seed)&U64;offset=BigInt(offset)&U64;
  let c=[offset&U32,offset>>32n,0n,0n], k=[seed&U32,seed>>32n];
  for(let round=0;round<10;round++){
    const a=0xd2511f53n*c[0], b=0xcd9e8d57n*c[2];
    c=[(b>>32n)^c[1]^k[0],b&U32,(a>>32n)^c[3]^k[1],a&U32];
    k=[(k[0]+0x9e3779b9n)&U32,(k[1]+0xbb67ae85n)&U32];
  }
  return f32(f32(Number(c[0]&0x7fffffffn))*f32(4.6566127342e-10));
}

export function fleetDraws({key,roundSeed,elapsed,phase,framesPerAction=15,shop=false,purchases=[]}){
  if(!Number.isInteger(roundSeed)||roundSeed<0||roundSeed>0xffffffff||
     !Number.isInteger(elapsed)||elapsed<0||!Number.isInteger(phase)||phase<0||phase>=60||
     !Number.isInteger(framesPerAction)||framesPerAction<1||60%framesPerAction!==0||
     (shop&&(purchases.length!==27||purchases.some(n=>!Number.isInteger(n)||n<0))))throw Error('Invalid sampling context');
  const step=shop?0x100000000n+purchases.reduce((sum,n)=>sum+BigInt(n),0n):
    (BigInt(elapsed)*60n+BigInt(phase))/BigInt(framesPerAction);
  return Float32Array.from({length:21},(_,head)=>philoxUniform(BigInt(key)+step,BigInt(roundSeed)*21n+BigInt(head)));
}

const shader=`
@group(0) @binding(0) var<storage,read> logits:array<f32>;
@group(0) @binding(1) var<storage,read> mask:array<i32>;
@group(0) @binding(2) var<storage,read> draws:array<f32>;
@group(0) @binding(3) var<storage,read_write> result:array<f32>;
fn logprob(value:f32,legal:bool,any_legal:bool,maximum:f32,log_sum:f32)->f32{
  if(!any_legal){return -log_sum;}if(!legal){return -3.402823466e38;}
  // Preserve the exact zero centered logit: shader reassociation can otherwise
  // absorb log_sum into an enormous maximum and turn a uniform head into p=1.
  if(value==maximum){return -log_sum;}
  return (value-maximum)-log_sum;
}
@compute @workgroup_size(32)
fn sample(@builtin(global_invocation_id) id:vec3<u32>){
  let head=id.x;if(head>=21u){return;}
  let offset=head*31u;let count=select(31u,442u,head==20u);
  var maximum=-3.402823466e38;var total=0.0;var any_legal=false;
  for(var a=0u;a<count;a++){
    if(mask[offset+a]==0){continue;}any_legal=true;let value=logits[offset+a];
    if(total==0.0||value>maximum){total*=exp(maximum-value);maximum=value;}
    total+=exp(value-maximum);
  }
  var log_sum=0.0;
  if(total==0.0){maximum=-10000.0;log_sum=log(f32(count));}else{log_sum=log(total);}
  var cumulative=0.0;var selected=count-1u;var picked=false;
  for(var a=0u;a<count;a++){
    cumulative+=exp(logprob(logits[offset+a],mask[offset+a]!=0,any_legal,maximum,log_sum));
    if(!picked&&draws[head]<cumulative){selected=a;picked=true;}
  }
  if(selected==count-1u&&mask[offset+selected]==0){
    for(var a=i32(count)-1;a>=0;a--){if(mask[offset+u32(a)]!=0){selected=u32(a);break;}}
  }
  result[head]=f32(selected);
  result[21u+head]=logprob(logits[offset+selected],mask[offset+selected]!=0,any_legal,maximum,log_sum);
}
@compute @workgroup_size(1)
fn joint(){var total=0.0;for(var head=0u;head<21u;head++){total+=result[21u+head];}result[42u]=total;}
`;

export class FleetSampler {
  static async create(device){
    const self=new FleetSampler();self.device=device;self.busy=false;
    self.buffers=[1063,1062,21,43].map((size,i)=>device.createBuffer({size:size*4,
      usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|(i===3?GPUBufferUsage.COPY_SRC:0)}));
    self.readback=device.createBuffer({size:43*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const layout=device.createBindGroupLayout({entries:self.buffers.map((buffer,binding)=>({binding,
      visibility:GPUShaderStage.COMPUTE,buffer:{type:binding===3?'storage':'read-only-storage'}}))});
    self.group=device.createBindGroup({layout,entries:self.buffers.map((buffer,binding)=>({binding,resource:{buffer}}))});
    const module=device.createShaderModule({code:shader});
    const errors=(await module.getCompilationInfo()).messages.filter(e=>e.type==='error');
    if(errors.length){self.destroy();throw Error(errors.map(e=>`${e.lineNum}: ${e.message}`).join('\n'));}
    const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]});
    self.pipelines=await Promise.all(['sample','joint'].map(entryPoint=>device.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint}})));
    return self;
  }
  async sample(logits,mask,draws){
    if(this.busy)throw Error('Sampler busy');
    if(!(logits instanceof Float32Array)||logits.length!==1063||!logits.every(Number.isFinite)||
       !(mask instanceof Int32Array)||mask.length!==1062||!mask.every(x=>x===0||x===1)||
       !(draws instanceof Float32Array)||draws.length!==21||!draws.every(x=>x>=0&&x<=1))throw Error('Invalid fleet sampler inputs');
    this.busy=true;
    try{
      [logits,mask,draws].forEach((data,i)=>this.device.queue.writeBuffer(this.buffers[i],0,data));
      const encoder=this.device.createCommandEncoder();
      for(const pipeline of this.pipelines){const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,this.group);pass.dispatchWorkgroups(1);pass.end();}
      encoder.copyBufferToBuffer(this.buffers[3],0,this.readback,0,43*4);this.device.queue.submit([encoder.finish()]);
      await this.readback.mapAsync(GPUMapMode.READ);const result=new Float32Array(this.readback.getMappedRange().slice(0));this.readback.unmap();
      return {choices:Int32Array.from(result.slice(0,21)),logprob:result[42]};
    }finally{this.busy=false;}
  }
  destroy(){for(const buffer of [...this.buffers,this.readback])buffer.destroy();}
}
