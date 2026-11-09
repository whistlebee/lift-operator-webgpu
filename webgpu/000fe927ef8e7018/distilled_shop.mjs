// Learned paid-shop decisions. The original game supplies the legal action mask.
export function logicalWeights(bytes,metadata,sizes){
 if(metadata.schema_version!==1||metadata.format!=='pufferlib.flat_float32'||metadata.dtype!=='float32'||metadata.endianness!=='little'||JSON.stringify(metadata.parameter_sizes)!==JSON.stringify(sizes)||bytes.byteLength!==metadata.padded_elements*4)throw Error('Unsupported distilled checkpoint');
 const source=new Float32Array(bytes),result=new Float32Array(sizes.reduce((a,b)=>a+b,0));let offset=0;
 sizes.forEach((n,i)=>{const begin=metadata.parameter_offsets[i];if(!Number.isInteger(begin)||begin<0||begin+n>source.length)throw Error('Invalid parameter offset');result.set(source.subarray(begin,begin+n),offset);offset+=n;});
 if(!result.every(Number.isFinite))throw Error('Nonfinite model weights');return result;
}
export function shopInputs(obs,credits,spent,purchases,previous){
 if(!Number.isInteger(credits)||!Number.isInteger(spent)||credits<0||spent<0||purchases.length!==27||!purchases.every(n=>Number.isInteger(n)&&n>=0)||!Number.isInteger(previous)||previous<0||previous>27)throw Error('Invalid shop inputs');
 const x=new Float32Array(212);x[0]=1;x.set(obs.subarray(0,25),1);x[26]=(credits+spent)/64;x[27]=credits/64;
 purchases.forEach((n,i)=>x[28+i]=n/16);x[55+previous]=1;x[83+Math.min(credits+spent,128)]=1;return x;
}
export class DistilledShop{
 static async create(device,bytes,metadata){
  const self=new DistilledShop();self.device=device;self.previous=27;
  const weights=logicalWeights(bytes,metadata,[27136,3612]);
  self.buffers=[weights.length,212,128+28].map(n=>device.createBuffer({size:n*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC}));
  self.readback=device.createBuffer({size:28*4,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(self.buffers[0],0,weights);
  const module=device.createShaderModule({code:`
@group(0) @binding(0) var<storage,read> w:array<f32>;
@group(0) @binding(1) var<storage,read> x:array<f32>;
@group(0) @binding(2) var<storage,read_write> out:array<f32>;
@compute @workgroup_size(64) fn hidden(@builtin(global_invocation_id) id:vec3<u32>){let h=id.x;if(h>=128u){return;}var z=0.0;for(var i=0u;i<212u;i++){z+=w[h*212u+i]*x[i];}out[h]=max(0.0,z);}
@compute @workgroup_size(32) fn output(@builtin(global_invocation_id) id:vec3<u32>){let a=id.x;if(a>=28u){return;}let offset=27136u+a*129u;var z=w[offset+128u];for(var h=0u;h<128u;h++){z+=w[offset+h]*out[h];}out[128u+a]=z;}
`});const info=await module.getCompilationInfo();if(info.messages.some(x=>x.type==='error')){self.destroy();throw Error(info.messages.map(x=>x.message).join('\n'));}
  const layout=device.createBindGroupLayout({entries:self.buffers.map((_,binding)=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:binding===2?'storage':'read-only-storage'}}))});
  self.group=device.createBindGroup({layout,entries:self.buffers.map((buffer,binding)=>({binding,resource:{buffer}}))});const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]});
  self.pipelines=await Promise.all(['hidden','output'].map(entryPoint=>device.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint}})));return self;
 }
 reset(){this.previous=27;}
 async choose(obs,mask,choices,credits,spent,purchases){
  if(obs[2410]===0)return choices;
  const x=shopInputs(obs,credits,spent,purchases,this.previous);this.device.queue.writeBuffer(this.buffers[1],0,x);const encoder=this.device.createCommandEncoder();
  this.pipelines.forEach((pipeline,i)=>{const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,this.group);pass.dispatchWorkgroups(i===0?2:1);pass.end();});
  encoder.copyBufferToBuffer(this.buffers[2],128*4,this.readback,0,28*4);this.device.queue.submit([encoder.finish()]);await this.readback.mapAsync(GPUMapMode.READ);const scores=new Float32Array(this.readback.getMappedRange().slice(0));this.readback.unmap();
  let best=-1e30,selected=27;for(let a=0;a<28;a++)if(mask[750+a]&&scores[a]>best){best=scores[a];selected=a;}
  if(!mask[750+selected])throw Error('No legal learned shop action');const result=choices.slice();result[20]=130+selected;this.previous=selected;return result;
 }
 destroy(){this.buffers?.forEach(x=>x.destroy());this.readback?.destroy();}
}
