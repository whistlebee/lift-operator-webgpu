import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
const manifestPath=new URL('../policy-manifest.json',import.meta.url);
const modules=fs.existsSync(manifestPath)?new URL('../'+JSON.parse(fs.readFileSync(manifestPath)).code_directory+'/',import.meta.url):new URL('../../graphics/lift_viewer/webgpu/',import.meta.url);
const {LiftHistory,encodeLiftInputs,liftLegality}=await import(new URL('distilled_lifts.mjs',modules));
const {shopInputs,logicalWeights}=await import(new URL('distilled_shop.mjs',modules));
const {CampaignPolicy,distilledConfiguration}=await import(new URL('campaign_policy.mjs',modules));
const settings=()=>({schema:1,kind:'distilled_campaign',frames_per_action:15,sampler_seed:20261103,reset_shop_memory_rounds:[21],item_timing:Array.from({length:25},()=>({musakSeconds:0,musakProfile:0,turboSeconds:0,turboProfile:0}))});
test('VIP history excludes pending/future information and remembers observed journeys',()=>{
 const o=new Float32Array(19704),h=new LiftHistory();o[4119]=.9;o[4120]=.8;o[4121]=.7;o[4344]=1;o[4348]=1;h.observe(o);assert.deepEqual([...h.values],[0,0,0,0,-1,-1,-1,-1]);
 o[4344]=31/51;o[4345]=10/30;o[4122]=.5;o[4118]=1/3;h.observe(o);o[4344]=0;o[4122]=.6;h.observe(o);
 assert.equal(h.values[4],Math.fround(10/30));assert.equal(h.values[5],Math.fround(1/20));assert.equal(h.values[6],.5);
 o[2410]=1;h.observe(o);assert.deepEqual([...h.values],Array(8).fill(-1));
});
test('coupled commands use root plus mirrored partner legality',()=>{
 const o=new Float32Array(19704),raw=new Int32Array(1062),partners=new Int32Array(20).fill(-1);o[2842]=o[2843]=1;partners[0]=1;partners[1]=0;raw[32]=1;
 const {mask,active}=liftLegality(o,raw,partners,{floors:3,lifts:2,shop:false});assert.equal(mask[0],1);assert.equal(active[0],1);assert.equal(active[1],0);assert.equal(mask[32],0);assert.equal(mask[30],1);assert.equal(mask[31],1);
 assert.equal(liftLegality(o,raw,partners,{floors:3,lifts:2,shop:true}).active.some(Boolean),false);
});
test('source lift encoding keeps full recurrent context and paired observations',()=>{
 const o=new Float32Array(19704),latent=Float32Array.from({length:64},(_,i)=>i/64),h=new Float32Array(8).fill(-1),base=new Int32Array(21).fill(30);o[7]=1;o[2842]=o[2843]=1;o[3160]=2/20;o[271+69+10]=.25;o[4122]=.6;h[6]=.5;base[0]=3;
 const x=encodeLiftInputs(o,latent,h,base);assert.equal(x[8],1);assert.equal(x[111],.25);assert.equal(x[484+3],1);assert.equal(x[542],1);assert.deepEqual([...x.slice(374,438)],[...latent]);assert.equal(x[444],Math.fround(o[4122]-.5));assert.equal(x[544*2],0);
});
test('learned shop inputs encode paid state and categorical opening credits',()=>{
 const o=new Float32Array(19704);o[20]=1;const bought=Array(27).fill(0);bought[3]=2;
 const x=shopInputs(o,31,9,bought,3);assert.equal(x.length,212);assert.equal(x[21],1);assert.equal(x[26],40/64);assert.equal(x[27],31/64);assert.equal(x[31],2/16);assert.equal(x[58],1);assert.equal(x[83+40],1);
 assert.throws(()=>shopInputs(o,-1,0,bought,27));
});
test('checkpoint parsing honors parameter padding',()=>{
 const raw=new Float32Array(16);raw.set([1,2,3],0);raw.set([4,5],8);const m={schema_version:1,format:'pufferlib.flat_float32',dtype:'float32',endianness:'little',parameter_sizes:[3,2],parameter_offsets:[0,8],padded_elements:16};assert.deepEqual([...logicalWeights(raw.buffer,m,[3,2])],[1,2,3,4,5]);assert.throws(()=>logicalWeights(raw.buffer,m,[5]));
});
test('composed policy uses learned heads and preserves item actions and memory reset',async()=>{
 const c=settings();for(const bad of [{...c,vip_reservation:true},{...c,reset_shop_memory_rounds:[21,21]}])assert.throws(()=>distilledConfiguration(bad));
 const p=new CampaignPolicy();p.controls=distilledConfiguration(c);const resets=[];p.shop={reset(){},async choose(o,m,a){const x=a.slice();if(o[2410])x[20]=157;return x;}};p.lifts={reset(){},prepare(){},async choose(o,m,h,a){const x=a.slice();if(!o[2410])x[0]=2;return x;}};p.policy={async step(o,m,c,opt){resets.push(opt.reset);return{choices:Int32Array.from([...Array(20).fill(30),223]),mask:m,hidden:new Float32Array(64)};}};
 for(const round of [20,21]){await p.request({reset:true,round,roundSeed:42,credits:0});const observation=Array(19704).fill(0);observation[round-1]=1;observation[2410]=1;const context=[0,0,15,4,...Array(8).fill(0),...Array(27).fill(0),...Array(20).fill(-1),...Array(20).fill(0)];const packet=()=>({observation,mask:Array(1062).fill(1),context});assert.equal((await p.request(packet())).action,777);observation[2410]=0;const play=await p.request(packet());assert.equal(play.action,843);assert.equal(play.lifts[0],2);context[1]=15;await p.request(packet());}assert.deepEqual(resets,[true,false,false,true,true,false]);
});
test('release bundle has only distilled policy assets and matching hashes',()=>{
 if(!fs.existsSync(manifestPath))return;const manifest=JSON.parse(fs.readFileSync(manifestPath));assert.equal(manifest.schema,2);
 for(const [name,expected]of Object.entries(manifest.weights)){assert(!/ordinary|budget|exchange|coupled|capsule|campaign-controls/.test(name));const bytes=fs.readFileSync(new URL('../policy/'+name,import.meta.url));assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),expected,name);if(name.endsWith('.json'))assert.doesNotMatch(bytes.toString(),/\/Users\/|\/home\/|\/root\//);}
 for(const name of ['shop.bin','lift.bin','distilled-policy.json'])assert(manifest.weights[name]);
});
