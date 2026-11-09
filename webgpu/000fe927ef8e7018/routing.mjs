// WGSL dispatch priors and shared routing head. All inputs are current public state.
// Mirrors dispatch_score.mojo and routing_head.mojo (schema16, normalized context).
export function routingShader(weightOffset, outputOffset) {
  return `
fn eligible_vip(car:u32,floor:u32,floors:u32)->f32 {
  let fb=31u+7u*floor;let lb=271u+69u*car;let mb=3154u+18u*car;
  if(observations[fb+4u]==0.0 || observations[lb+2u]!=0.0 ||
     observations[lb+38u]!=0.0 || observations[mb+13u]!=0.0){return 0.0;}
  let zoned=observations[3088u]!=0.0;let top=f32(max(1u,floors-1u));
  let lower=u32(observations[mb+4u]*top+0.5);let upper=u32(observations[mb+5u]*top+0.5);
  if(zoned && floor!=0u && (floor<lower||floor>upper)){return 0.0;}
  let capacity=observations[mb+1u]*20.0;let stinky=observations[lb+7u]!=0.0;
  var count=0.0;
  for(var slot=0u;slot<1024u;slot++){
    let p=4344u+15u*slot;let location=observations[p];if(location==0.0){break;}
    let group=i32(location*51.0+0.5)-1;if(group>i32(floor)){break;}
    if(group!=i32(floor)||observations[p+4u]==0.0||observations[p+9u]!=0.0){continue;}
    let dest=i32(observations[p+1u]*30.0+0.5)-1;if(dest<0){continue;}
    if(zoned&&dest!=0&&(dest<i32(lower)||dest>i32(upper))){continue;}
    if(observations[p+3u]*3.0>capacity){continue;}
    if(stinky&&observations[p+5u]==0.0){continue;}
    if(observations[p+13u]!=0.0 &&
       i32(observations[p+11u]*20.0+0.5)-1==i32(car) &&
       i32(observations[p+12u]*30.0+0.5)-1==i32(floor)){continue;}
    count+=1.0;
  }
  return count;
}

fn route_feature(car:u32,destination:u32,feature:u32,floors:u32)->f32 {
  let lb=271u+69u*car;let fb=31u+7u*destination;let rb=2862u;
  let top=f32(max(1u,floors-1u));let position=observations[lb]*top;
  if(feature==0u){return observations[lb+8u+destination];}
  if(feature==1u){return observations[fb];}
  if(feature==2u){return observations[fb+3u];}
  if(feature==3u){return observations[fb+4u];}
  if(feature==4u){return observations[fb+5u];}
  if(feature==5u){return observations[lb+2u];}
  if(feature==6u){return (f32(destination)-position)/top;}
  if(feature==7u){return observations[rb+120u+car];}
  if(feature>=8u&&feature<12u){return observations[rb+4u*destination+feature-8u];}
  if(feature>=12u&&feature<16u){
    var total=0.0;
    for(var floor=0u;floor<floors;floor++){
      if(((feature==12u||feature==14u)&&f32(floor)>position)||
         ((feature==13u||feature==15u)&&f32(floor)<position)){
        if(feature<14u){total+=observations[lb+8u+floor];}
        else{total+=observations[31u+7u*floor];}
      }
    }return total;
  }
  if(feature==16u){return observations[lb+6u];}
  if(feature==17u){return observations[lb+7u];}
  let ready=2662u+9u*car;
  if(feature==18u){return observations[ready];}
  if(feature==19u){return observations[ready+8u];}
  if(feature==20u){return observations[ready+6u];}
  if(feature==21u){return observations[27u];}
  if(feature==22u){return observations[28u];}
  return f32(destination)/top;
}

@compute @workgroup_size(64)
fn route(@builtin(global_invocation_id) id:vec3<u32>){
  let action=id.x;if(action>=1063u){return;}
  let output=${outputOffset}u+action;values[output]=values[7296u+action];
  if(action>=600u){return;}
  let car=action/30u;let floor=action%30u;
  let floors=u32(observations[25u]*30.0+0.5);let lifts=u32(observations[26u]*20.0+0.5);
  if(car>=lifts||floor>=floors){return;}
  let w=${weightOffset}u;let fb=31u+7u*floor;let lb=271u+69u*car;
  let waiting=observations[fb]*10.0;let age=observations[fb+5u];let load=observations[lb+2u];
  let free=max(0.0,1.0-load);let cargo=observations[lb+8u+floor]*12.0;
  let pickup=observations[3514u+car*30u+floor]>0.0;
  var demand=cargo+waiting*free>0.0;if(!pickup){demand=cargo>0.0;}
  let available=observations[3514u+car*30u+floor]*10.0*free;
  let top=f32(max(1u,floors-1u));let distance=abs(observations[lb]*top-f32(floor))/top;
  var score=weights[w]*cargo+weights[w+1u]*available;
  if(demand&&pickup){
    score+=weights[w+2u]*(1.0+age)*min(1.0,waiting);
    score+=weights[w+3u]*observations[fb+3u]*10.0;
    score+=weights[w+4u]*eligible_vip(car,floor,floors);
  }
  score+=weights[w+5u]*distance;
  if(!demand){score+=weights[w+6u];}
  if(pickup){score+=weights[w+7u]*available*distance;}
  score+=weights[w+8u]*cargo*distance;
  if(pickup){score+=weights[w+9u]*age*available*distance;}
  if(demand&&pickup){score+=weights[w+10u]*observations[fb+3u]*10.0*distance;}
  if(pickup){score+=weights[w+11u]*waiting*load;}
  values[output]+=score;
  var squared=0.0;for(var j=0u;j<64u;j++){let x=values[6976u+j];squared+=x*x;}
  let scale=1.0/sqrt(squared/64.0+0.000001);
  var x:array<f32,24>;for(var j=0u;j<24u;j++){x[j]=route_feature(car,floor,j,floors);}
  var residual=0.0;
  for(var unit=0u;unit<4u;unit++){
    let base=w+12u+unit*89u;var total=weights[base+88u];
    for(var j=0u;j<24u;j++){total+=weights[base+j]*x[j];}
    for(var j=0u;j<64u;j++){total+=weights[base+24u+j]*values[6976u+j]*scale;}
    residual+=weights[w+368u+unit]*tanh(total);
  }
  values[output]+=residual;
}`;
}
