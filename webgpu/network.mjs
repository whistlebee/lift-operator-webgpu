// Native WebGPU neural core. Policy controllers and action sampling are separate.
// Layout follows passenger_encoder.mojo and the FP32 MinGRU path in nn.mojo.
import {routingShader} from './routing.mjs';
export const SHAPE = Object.freeze({observations:19704, features:6843, width:64,
  layers:4, outputs:1063, encoded:6848, hiddenA:6912, hiddenB:6976,
  state:7040, raw:7296, routed:8360, scratch:9423});

function shader(offsets) {
  return `
@group(0) @binding(0) var<storage, read> weights: array<f32>;
@group(0) @binding(1) var<storage, read> observations: array<f32>;
@group(0) @binding(2) var<storage, read_write> values: array<f32>;
@group(0) @binding(3) var<uniform> options: vec4<u32>;

@compute @workgroup_size(16)
fn passengers(@builtin(global_invocation_id) id: vec3<u32>) {
  let channel=id.x;
  if(channel>=16u){return;}
  let w=${offsets[4]}u+channel*15u;
  var slot=0u;
  for(var group=0u;group<51u;group++){
    var total=0.0; var peak=0.0; var first=0.0; var count=0u;
    loop {
      if(slot>=1024u){break;}
      let base=4344u+slot*15u;
      let location=observations[base];
      if(location==0.0 || u32(location*51.0+0.5)!=group+1u){break;}
      var value=weights[w+14u];
      for(var feature=0u;feature<14u;feature++){
        value+=weights[w+feature]*observations[base+1u+feature];
      }
      value=max(0.0,value); total+=value; peak=max(peak,value);
      if(count==0u){first=value;}
      count++;slot++;
    }
    let base=4344u+group*49u;
    values[base+channel]=total/16.0;
    values[base+16u+channel]=peak;
    values[base+32u+channel]=first;
    if(channel==0u){values[base+48u]=f32(count)/16.0;}
  }
  for(var feature=channel;feature<4344u;feature+=16u){values[feature]=observations[feature];}
}

@compute @workgroup_size(64)
fn encode(@builtin(global_invocation_id) id: vec3<u32>){
  let channel=id.x;if(channel>=64u){return;}
  var total=0.0;
  for(var feature=0u;feature<6843u;feature++){
    total+=values[feature]*weights[${offsets[0]}u+channel*6843u+feature];
  }
  values[6848u+channel]=total;
}

fn sigmoid(x:f32)->f32{return 1.0/(1.0+exp(-x));}
fn layer(channel:u32,index:u32,input:u32,output:u32){
  let w=${offsets[2]}u+index*12288u+channel*64u;
  var projection=0.0;var update=0.0;var highway=0.0;
  for(var feature=0u;feature<64u;feature++){
    let x=values[input+feature];
    projection+=x*weights[w+feature];
    update+=x*weights[w+4096u+feature];
    highway+=x*weights[w+8192u+feature];
  }
  var candidate=sigmoid(projection);
  if(projection>=0.0){candidate=projection+0.5;}
  let gate=sigmoid(update);
  let address=7040u+index*64u+channel;
  var previous=values[address];if(options.x!=0u){previous=0.0;}
  let difference=candidate-previous;
  var next=candidate-difference*(1.0-gate);
  if(abs(gate)<0.5){next=previous+gate*difference;}
  let bypass=sigmoid(highway);
  values[output+channel]=bypass*next+(1.0-bypass)*values[input+channel];
  values[address]=next;
}
@compute @workgroup_size(64) fn layer0(@builtin(global_invocation_id) id:vec3<u32>){layer(id.x,0u,6848u,6912u);}
@compute @workgroup_size(64) fn layer1(@builtin(global_invocation_id) id:vec3<u32>){layer(id.x,1u,6912u,6976u);}
@compute @workgroup_size(64) fn layer2(@builtin(global_invocation_id) id:vec3<u32>){layer(id.x,2u,6976u,6912u);}
@compute @workgroup_size(64) fn layer3(@builtin(global_invocation_id) id:vec3<u32>){layer(id.x,3u,6912u,6976u);}
@compute @workgroup_size(64)
fn decode(@builtin(global_invocation_id) id:vec3<u32>){
  let channel=id.x;if(channel>=1063u){return;}
  var total=0.0;
  for(var feature=0u;feature<64u;feature++){
    total+=values[6976u+feature]*weights[${offsets[1]}u+channel*64u+feature];
  }
  values[7296u+channel]=total;
}
${routingShader(offsets[3],SHAPE.routed)}`;
}

export class LiftNetwork {
  static async create(device, bytes, metadata) {
    const sizes=[437952,68032,49152,372,240], offsets=[0,437952,505984,555136,555512];
    if(metadata.schema_version!==1 || metadata.format!=='pufferlib.flat_float32' ||
       metadata.dtype!=='float32' || metadata.endianness!=='little' ||
       JSON.stringify(metadata.parameter_sizes)!==JSON.stringify(sizes) ||
       JSON.stringify(metadata.parameter_offsets)!==JSON.stringify(offsets) ||
       bytes.byteLength!==555752*4) throw Error('Unsupported Lift network checkpoint');
    const net=new LiftNetwork();net.device=device;net.busy=false;
    const allocate=(size,usage)=>device.createBuffer({size,usage});
    net.weights=allocate(bytes.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);
    net.observations=allocate(SHAPE.observations*4,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);
    net.values=allocate(SHAPE.scratch*4,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST);
    net.options=allocate(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    net.readback=allocate(SHAPE.scratch*4,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(net.weights,0,bytes);
    const layout=device.createBindGroupLayout({entries:[
      {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
      {binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
      {binding:2,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}},
      {binding:3,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}}]});
    net.bindings=device.createBindGroup({layout,entries:[net.weights,net.observations,net.values,net.options].map((buffer,binding)=>({binding,resource:{buffer}}))});
    const module=device.createShaderModule({code:shader(offsets)});
    const compilation=await module.getCompilationInfo();
    const errors=compilation.messages.filter(message=>message.type==='error');
    if(errors.length){net.destroy();throw Error(errors.map(e=>`${e.lineNum}:${e.linePos} ${e.message}`).join('\n'));}
    const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]});
    net.pipelines=await Promise.all(['passengers','encode','layer0','layer1','layer2','layer3','decode','route'].map(entryPoint=>
      device.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint}})));
    return net;
  }

  async step(observation,{reset=false}={}) {
    if(this.busy)throw Error('A network step is already running');
    if(!(observation instanceof Float32Array)||observation.length!==SHAPE.observations||!observation.every(Number.isFinite))throw Error('Invalid Lift observation');
    this.busy=true;
    try {
      this.device.queue.writeBuffer(this.observations,0,observation);
      this.device.queue.writeBuffer(this.options,0,new Uint32Array([Number(reset),0,0,0]));
      const encoder=this.device.createCommandEncoder();
      for(let i=0;i<this.pipelines.length;i++){
        const pass=encoder.beginComputePass();pass.setPipeline(this.pipelines[i]);pass.setBindGroup(0,this.bindings);
        pass.dispatchWorkgroups(i>=6?Math.ceil(SHAPE.outputs/64):1);pass.end();
      }
      encoder.copyBufferToBuffer(this.values,0,this.readback,0,SHAPE.scratch*4);
      this.device.queue.submit([encoder.finish()]);
      await this.readback.mapAsync(GPUMapMode.READ);
      const result=new Float32Array(this.readback.getMappedRange().slice(0));this.readback.unmap();
      return {features:result.slice(0,SHAPE.features),encoded:result.slice(SHAPE.encoded,SHAPE.encoded+64),
        hidden:result.slice(SHAPE.hiddenB,SHAPE.hiddenB+64),state:result.slice(SHAPE.state,SHAPE.state+256),
        raw:result.slice(SHAPE.raw,SHAPE.raw+SHAPE.outputs),routed:result.slice(SHAPE.routed,SHAPE.routed+SHAPE.outputs)};
    } finally {this.busy=false;}
  }

  destroy(){for(const buffer of [this.weights,this.observations,this.values,this.options,this.readback])buffer.destroy();}
}
