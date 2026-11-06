import {test} from 'node:test';
import assert from 'node:assert/strict';
import {VipReservation,campaignControls} from '../webgpu/vip_reservation.mjs';
import {CampaignPolicy} from '../webgpu/campaign_policy.mjs';
function initial(){
 const o=new Float32Array(19704),m=new Int32Array(1062);
 o[7]=1;o[25]=15/30;o[26]=4/20;o[27]=111/180;o[4118]=1/3;
 for(let c=0;c<4;c++){o[2842+c]=1;o[271+69*c]=3/14;o[272+69*c]=3/14;o[273+69*c]=.5;}
 o[4344]=31/51;o[4345]=4/30;o[4348]=1;m[4]=1;return {o,m};
}
test('public VIP history matches native GPU causality and legality fixtures',()=>{
 const {o,m}=initial(),a=new VipReservation(),b=new VipReservation();
 assert.equal(a.prepare(o,m),null);assert.equal(b.prepare(o,m),null);
 assert.deepEqual([...a.history],[1,3,0,-1,-1,-1]);
 o[27]=110/180;o[4118]=2/3;o[273]=0;o[4344]=0;
 const poisoned=o.slice();poisoned[4119]=.8;poisoned[4120]=1;poisoned[4121]=.01;poisoned[4344]=1;poisoned[4345]=.9;poisoned[4354]=.7;
 const plan=a.prepare(o,m);assert.deepEqual(plan,{car:0,command:4});assert.deepEqual(b.prepare(poisoned,m),plan);assert.deepEqual(a.history,b.history);
 const full=new Int32Array(1062),choices=new Int32Array(21).fill(30);a.apply(plan,full,choices);
 assert.equal(full.reduce((a,b)=>a+b,0),1);assert.equal(full[4],1);assert.deepEqual([...choices],[4,...Array(20).fill(30)]);
 m.fill(0);assert.equal(a.prepare(o,m),null);
 o[27]=78/180;assert.equal(a.prepare(o,m),null);assert.equal(a.history[0],-1);
 o[4344]=4/51;o[4345]=6/30;o[4355]=1/20;o[4356]=4/30;o[4357]=1;o[3517]=.1;o[271]=4/14;o[272]=4/14;m[3]=1;
 assert.equal(a.prepare(o,m),null);o[4357]=0;assert.deepEqual(a.prepare(o,m),{car:0,command:3});
 o[273]=.1;assert.equal(a.prepare(o,m),null);o[273]=0;o[277]=1;assert.equal(a.prepare(o,m),null);
 assert.equal(a.prepare(o,m,true),null);assert.deepEqual([...a.history],Array(6).fill(-1));
});
test('campaign settings validate and reset memory only at the selected gameplay boundary',async()=>{
 for(const bad of [{reset_shop_memory_rounds:[0]},{reset_shop_memory_rounds:[21,21]},{vip_reservation:1},{extra:1}])assert.throws(()=>campaignControls(bad));
 const p=new CampaignPolicy();p.controls=campaignControls({reset_shop_memory_rounds:[21]});p.vip=new VipReservation();
 p.shop={reset(){},timing(){return null;},choose(l,m,c){return {choices:c};}};
 const resets=[];p.policy={async step(o,m,c,opt){resets.push(opt.reset);return {logits:[],mask:m,choices:new Int32Array(21).fill(30)};}};
 p.controllers={serviceOptions(){return {};},async apply(o,l,m,c){return c;}};
 for(const r of [20,21]){
  await p.request({reset:true,round:r,roundSeed:42,credits:0});
  const obs=new Float32Array(19704);obs[r-1]=1;obs[2410]=1;
  const context=[0,0,15,4,...Array(8).fill(0),...Array(27).fill(0),...Array(20).fill(-1),...Array(20).fill(0)];
  const packet=()=>({observation:[...obs],mask:Array(1062).fill(1),context});
  await p.request(packet());obs[2410]=0;await p.request(packet());context[1]=15;await p.request(packet());
 }
 assert.deepEqual(resets,[true,false,false,true,true,false]);
});

test('all inference assets match their manifest and contain no local paths',async()=>{
 const fs=await import('node:fs'),crypto=await import('node:crypto');
 const root=new URL('../',import.meta.url);
 const manifest=JSON.parse(fs.readFileSync(new URL('policy-manifest.json',root)));
 for(const [name,expected] of Object.entries(manifest.weights)){
  const bytes=fs.readFileSync(new URL('policy/'+name,root));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),expected,name);
  if(name.endsWith('.json'))assert.doesNotMatch(bytes.toString(),/\/Users\/|\/home\/|\/root\//);
 }
});
