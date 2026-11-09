// Shared learned floor scorer. Only visible state and observed VIP history enter it.
import {logicalWeights} from './distilled_shop.mjs';
const F=Math.fround, decode=(v,n)=>Math.trunc(F(F(v*n)+.5));
export class LiftHistory {
  constructor(){this.values=new Float32Array(8);this.reset();}
  reset(){this.values.fill(-1);}
  observe(o){
    const h=this.values;if(o[2410]!==0){this.reset();return;}
    let origin=-1,dest=-1,blocked=-1,age=0;
    for(let slot=0;slot<1024;slot++){
      const r=4344+15*slot,group=decode(o[r],51)-1;
      if(group<0||group>=30)break;if(o[r+4]===0)continue;
      origin=group;dest=decode(o[r+1],30)-1;age=o[r+2];
      if(o[r+13]!==0&&decode(o[r+12],30)-1===origin)blocked=decode(o[r+11],20)-1;
      break;
    }
    h[0]=F((origin+1)/30);h[1]=F((dest+1)/30);h[2]=F((blocked+1)/20);h[3]=age;
    for(let slot=0;slot<1024;slot++){
      const r=4344+15*slot,group=decode(o[r],51)-1;if(group<0)break;
      if(group>=30&&group<50&&o[r+4]!==0){h[4]=o[r+1];h[5]=F((group-29)/20);h[6]=o[4122];h[7]=o[4118];break;}
    }
  }
}
export function encodeLiftInputs(o,latent,history,base){
  if(latent.length!==64||history.length!==8||base.length!==21)throw Error('Invalid lift feature inputs');
  const inputs=new Float32Array(20*544);
  for(let car=0;car<20;car++){
    if(o[2410]!==0||o[2842+car]===0)continue;
    const x=inputs.subarray(car*544,(car+1)*544),partner=decode(o[3160+18*car],20)-1,paired=partner>=0&&partner<20;
    x[0]=1;x.set(o.subarray(0,31),1);
    x.set(o.subarray(271+69*car,271+69*car+69),32);
    if(paired)x.set(o.subarray(271+69*partner,271+69*partner+69),101);
    x.set(o.subarray(3514+30*car,3514+30*car+30),170);
    if(paired)x.set(o.subarray(3514+30*partner,3514+30*partner+30),200);
    for(let floor=0;floor<30;floor++)x[230+floor]=o[31+7*floor+5];
    for(let c=0;c<20;c++){for(let j=0;j<3;j++)x[260+3*c+j]=o[271+69*c+j];x[446+c]=o[2842+c];}
    x.set(o.subarray(3154+18*car,3154+18*car+18),320);
    if(paired)x.set(o.subarray(3154+18*partner,3154+18*partner+18),338);
    x.set(o.subarray(2662+9*car,2662+9*car+9),356);
    if(paired)x.set(o.subarray(2662+9*partner,2662+9*partner+9),365);
    x.set(latent,374);x.set(history,438);if(history[6]>=0)x[444]=F(o[4122]-history[6]);
    x[466]=F(car/20);x[467]=o[4122];x[468]=o[4118];x[469]=o[4114];x[470]=F((partner+1)/20);
    x.set(o.subarray(3082,3094),471);if(base[car]>=0&&base[car]<=30)x[484+base[car]]=1;
    for(let j=0;j<20;j++)x[515+j]=o[2663+9*j];
    x.set(o.subarray(4134+6*car,4134+6*car+6),535);x[541]=car%2;x[542]=Number(paired);x[543]=o[4123];
  }
  return inputs;
}
export function liftLegality(o,raw,partners,{floors,lifts,shop,done=false}){
  const mask=new Int32Array(20*32),active=new Int32Array(20);
  for(let car=0;car<20;car++){
    mask[car*32+30]=mask[car*32+31]=1;
    if(shop||done||car>=lifts||o[2842+car]===0)continue;
    const partner=partners[car];if(partner>=0&&partner<car)continue;
    for(let floor=0;floor<floors;floor++){
      let legal=raw[car*30+floor];if(partner>=0)legal=Math.max(legal,raw[partner*30+floors-1-floor]);
      mask[car*32+floor]=legal;active[car]|=legal;
    }
  }
  return {mask,active};
}
export class DistilledLifts{
  static async create(device,bytes,metadata){
    const self=new DistilledLifts();self.device=device;self.history=new LiftHistory();
    const weights=logicalWeights(bytes,metadata,[8192,33,256]);
    self.buffers=[weights.length,20*544,20*32,20,20*32].map(n=>device.createBuffer({size:n*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST}));
    self.readback=device.createBuffer({size:20*32*4,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(self.buffers[0],0,weights);
    const response=await fetch(new URL('./lift_features.wgsl',import.meta.url));if(!response.ok)throw Error('Lift feature shader unavailable');
    const features=await response.text();
    const linear=Array.from({length:256},(_,i)=>`value+=weights[${8225+i}u]*f[${i}];`).join('\n');
    const hidden=Array.from({length:256},(_,i)=>`z+=weights[h*256u+${i}u]*f[${i}];`).join('\n');
    const module=device.createShaderModule({code:`
@group(0) @binding(0) var<storage,read> weights:array<f32>;
@group(0) @binding(1) var<storage,read> inputs:array<f32>;
@group(0) @binding(2) var<storage,read> legal:array<i32>;
@group(0) @binding(3) var<storage,read> eligible:array<i32>;
@group(0) @binding(4) var<storage,read_write> scores:array<f32>;
${features}
@compute @workgroup_size(32) fn score(@builtin(global_invocation_id) id:vec3<u32>){
 let car=id.x/32u;let a=id.x%32u;if(car>=20u||eligible[car]==0||legal[id.x]==0){return;}
 let f=features(i32(car),i32(a));var value=weights[8224u];${linear}
 for(var h=0u;h<32u;h++){var z=0.0;${hidden}value+=weights[8192u+h]*max(0.0,z);}
 scores[id.x]=value;
}`});
    const info=await module.getCompilationInfo();if(info.messages.some(x=>x.type==='error')){self.destroy();throw Error(info.messages.map(x=>`${x.lineNum}: ${x.message}`).join('\n'));}
    const layout=device.createBindGroupLayout({entries:self.buffers.map((_,binding)=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:binding===4?'storage':'read-only-storage'}}))});
    self.group=device.createBindGroup({layout,entries:self.buffers.map((buffer,binding)=>({binding,resource:{buffer}}))});self.pipeline=await device.createComputePipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[layout]}),compute:{module,entryPoint:'score'}});return self;
  }
  reset(){this.history.reset();}
  prepare(obs){this.history.observe(obs);}
  async choose(obs,raw,hidden,base,context){
    const {mask,active}=liftLegality(obs,raw,context.partners,context);if(!active.some(Boolean))return base.slice();
    const inputs=encodeLiftInputs(obs,hidden,this.history.values,base);
    this.device.queue.writeBuffer(this.buffers[1],0,inputs);this.device.queue.writeBuffer(this.buffers[2],0,mask);this.device.queue.writeBuffer(this.buffers[3],0,active);
    const encoder=this.device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.group);pass.dispatchWorkgroups(20);pass.end();encoder.copyBufferToBuffer(this.buffers[4],0,this.readback,0,20*32*4);this.device.queue.submit([encoder.finish()]);
    await this.readback.mapAsync(GPUMapMode.READ);const scores=new Float32Array(this.readback.getMappedRange().slice(0));this.readback.unmap();
    const choices=base.slice();for(let car=0;car<20;car++){
      if(!active[car])continue;let best=-1e30,selected=31;
      for(let a=0;a<32;a++)if(mask[car*32+a]&&scores[car*32+a]>best){best=scores[car*32+a];selected=a;}
      if(selected<31)choices[car]=selected;
    }
    this.lastScores=scores;this.lastInputs=inputs;return choices;
  }
  destroy(){this.buffers?.forEach(x=>x.destroy());this.readback?.destroy();}
}
