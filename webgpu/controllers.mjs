// Visible-VIP response and learned round25 capsule dispatch. These choose legal
// actions from current observations; they never advance or modify game state.
const shader=`
@group(0) @binding(0) var<storage,read> obs:array<f32>;
@group(0) @binding(1) var<storage,read> mask:array<i32>;
@group(0) @binding(2) var<storage,read> weights:array<f32>;
@group(0) @binding(3) var<storage,read_write> choices:array<i32>;
struct Options{done:u32,shop:u32,decks:u32,padding:u32}
@group(0) @binding(4) var<uniform> options:Options;
@compute @workgroup_size(1)
fn vip(){
  if(options.done!=0u||options.shop!=0u||obs[4117]==0.0){return;}
  var origin=-1;var dest=-1;var blocked=-1;
  for(var slot=0u;slot<1024u;slot++){
    let b=4344u+15u*slot;let floor=i32(obs[b]*51.0+0.5)-1;
    if(floor<0||floor>=30){break;}
    if(obs[b+4u]==0.0){continue;}
    origin=floor;dest=i32(obs[b+1u]*30.0+0.5)-1;
    if(obs[b+13u]!=0.0&&i32(obs[b+12u]*30.0+0.5)-1==origin){blocked=i32(obs[b+11u]*20.0+0.5)-1;}
    break;
  }
  let floors=i32(obs[25]*30.0+0.5);let cars=i32(obs[26]*20.0+0.5);
  if(origin<0||origin>=floors||dest<0||dest>=floors){return;}
  var nearest=-1;var best=f32(floors);
  for(var car=0;car<cars;car++){
    let b=271+69*car;
    if(obs[b+6]!=0.0||obs[3160+18*car]!=0.0||(options.decks&(1u<<u32(car)))!=0u||car==blocked||obs[b+2]!=0.0||obs[b+7]!=0.0||obs[3514+30*car+origin]<=0.0){continue;}
    let lower=i32(obs[3158+18*car]*f32(floors-1)+0.5);
    let upper=i32(obs[3159+18*car]*f32(floors-1)+0.5);
    if((origin!=0&&(origin<lower||origin>upper))||(dest!=0&&(dest<lower||dest>upper))){continue;}
    let destination=i32(obs[b+1]*f32(floors-1)+0.5);let action=choices[car];
    if(action==origin||(action==30&&destination==origin)){return;}
    let command=select(origin,30,destination==origin);
    if(mask[31*car+command]==0){continue;}
    let travel=abs(obs[b]*f32(floors-1)-f32(origin));
    if(travel<best){nearest=car;best=travel;}
  }
  if(nearest>=0){
    let destination=i32(obs[272+69*nearest]*f32(floors-1)+0.5);
    choices[nearest]=select(origin,30,destination==origin);
  }
}
@compute @workgroup_size(1)
fn capsule(){
  if(options.done!=0u||obs[24]==0.0||obs[2410]!=0.0){return;}
  var trips:array<i32,32>;var claimed:array<i32,20>;
  for(var car=0;car<20;car++){
    claimed[car]=-1;let b=271+69*car;
    if(obs[2842+car]==0.0||obs[b+2]>0.0||obs[b+6]>0.0){continue;}
    let ready=2662+9*car;
    if(obs[ready+1]>0.0||obs[ready+2]>0.0||obs[ready+3]>0.0||obs[b+5]>0.0){
      let destination=i32(obs[b+1]*29.0+0.5);
      if(obs[3514+30*car+destination]>0.0){claimed[car]=destination;trips[destination]++;}
    }
  }
  for(var car=0;car<20;car++){
    let b=271+69*car;if(obs[2842+car]==0.0||obs[b+6]>0.0){continue;}
    let ready=2662+9*car;let loaded=obs[b+2]>0.0;
    let service=obs[ready+2]>0.0||obs[b+5]>0.0||obs[ready+3]>0.0;
    let transit=obs[ready+1]>0.0;let destination=i32(obs[b+1]*29.0+0.5);let position=obs[b]*29.0;
    if(claimed[car]>=0){trips[destination]--;}
    let offset=16*(select(0,1,loaded)+select(0,2,service)+select(0,4,transit));
    var predicted=30;var best=-1e30;
    for(var action=0;action<31;action++){
      if(mask[31*car+action]==0){continue;}
      let hold=action==30;let floor=select(action,destination,hold);
      let queue=obs[3514+30*car+floor]*10.0;let others=trips[floor];
      let age=obs[31+7*floor+5];let distance=abs(position-f32(floor))/29.0;
      var x:array<f32,16>;
      x[0]=select(0.0,1.0,hold);x[1]=select(0.0,1.0,destination==floor);
      x[2]=select(0.0,1.0,obs[b+8+floor]>0.0);x[3]=select(0.0,1.0,queue>f32(others)+0.5);
      x[4]=select(0.0,1.0,queue>0.0);x[5]=age;x[6]=distance;x[7]=min(1.0,f32(others)/4.0);
      x[8]=age*x[3];x[9]=distance*x[3];x[10]=x[0]*x[3];x[11]=x[1]*x[3];
      x[12]=x[0]*x[2];x[13]=select(0.0,1.0,distance<0.001);x[14]=min(1.0,queue/4.0);x[15]=select(0.0,1.0,others>0);
      var score=0.0;for(var j=0;j<16;j++){score+=weights[offset+j]*x[j];}
      if(score>best||(score==best&&hold)){best=score;predicted=action;}
    }
    choices[car]=predicted;
    if(!loaded){let dest=select(predicted,destination,predicted==30);if(obs[3514+30*car+dest]>0.0){trips[dest]++;}}
  }
}
`;

export class LiftControllers{
  static async create(device,capsule){
    if(capsule.schema!==1||capsule.kind!=='capsule_dispatch_student'||capsule.round!==25||
       !Array.isArray(capsule.weights)||capsule.weights.length!==128||!capsule.weights.every(Number.isFinite))throw Error('Unsupported capsule controller');
    const self=new LiftControllers();self.device=device;self.busy=false;
    self.buffers=[19704,1062,128,21].map((n,i)=>device.createBuffer({size:n*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|(i===3?GPUBufferUsage.COPY_SRC:0)}));
    self.options=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    self.readback=device.createBuffer({size:84,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(self.buffers[2],0,new Float32Array(capsule.weights));
    const layout=device.createBindGroupLayout({entries:[...self.buffers.map((_,binding)=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:binding===3?'storage':'read-only-storage'}})),{binding:4,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}}]});
    self.group=device.createBindGroup({layout,entries:[...self.buffers,self.options].map((buffer,binding)=>({binding,resource:{buffer}}))});
    try{
      const module=device.createShaderModule({code:shader});
      const errors=(await module.getCompilationInfo()).messages.filter(e=>e.type==='error');
      if(errors.length)throw Error(errors.map(e=>`${e.lineNum}: ${e.message}`).join('\n'));
      const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]});
      self.pipelines=Object.fromEntries(await Promise.all(['vip','capsule'].map(async entryPoint=>[entryPoint,await device.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint}})])));
      return self;
    }catch(error){self.destroy();throw error;}
  }
  async apply(stage,obs,mask,choices,{done=false,shop=false,doubleDeckMask=0}={}){
    if(this.busy)throw Error('Lift controllers busy');
    if(!['vip','capsule'].includes(stage)||!(obs instanceof Float32Array)||obs.length!==19704||!obs.every(Number.isFinite)||
       !(mask instanceof Int32Array)||mask.length!==1062||!mask.every(n=>n===0||n===1)||
       !(choices instanceof Int32Array)||choices.length!==21||!choices.every((n,i)=>n>=0&&n<(i<20?31:442))||
       ![false,true,0,1].includes(done)||![false,true,0,1].includes(shop)||!Number.isInteger(doubleDeckMask)||doubleDeckMask<0||doubleDeckMask>0xfffff)throw Error('Invalid controller inputs');
    this.busy=true;
    try{
      this.device.queue.writeBuffer(this.buffers[0],0,obs);this.device.queue.writeBuffer(this.buffers[1],0,mask);this.device.queue.writeBuffer(this.buffers[3],0,choices);
      this.device.queue.writeBuffer(this.options,0,new Uint32Array([Number(done),Number(shop),doubleDeckMask,0]));
      const encoder=this.device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(this.pipelines[stage]);pass.setBindGroup(0,this.group);pass.dispatchWorkgroups(1);pass.end();
      encoder.copyBufferToBuffer(this.buffers[3],0,this.readback,0,84);this.device.queue.submit([encoder.finish()]);
      await this.readback.mapAsync(GPUMapMode.READ);const result=new Int32Array(this.readback.getMappedRange().slice(0));this.readback.unmap();return result;
    }finally{this.busy=false;}
  }
  destroy(){for(const b of [...this.buffers,this.options,this.readback])b.destroy();}
}
