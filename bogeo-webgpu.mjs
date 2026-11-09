import {CampaignPolicy,loadCampaignAssets} from './webgpu/000fe927ef8e7018/campaign_policy.mjs';
const status=document.createElement('div');
status.style='position:fixed;top:0;left:0;right:0;z-index:999999;padding:16px;background:#15222d;color:white;font:16px system-ui';
status.textContent='Loading browser policy…';document.body.append(status);
try{
  const adapter=await navigator.gpu?.requestAdapter();if(!adapter)throw Error('This browser does not provide WebGPU. Try a current Chrome or Edge browser.');
  const device=await adapter.requestDevice();
  const assets=await loadCampaignAssets(new URL('./policy/',import.meta.url));
  const policy=await CampaignPolicy.create(device,assets);
  window.bogeoBrowserPolicy=policy;
  window.bogeoPolicyConfig={checkpoint:'Distilled campaign policy',inference:'webgpu',bundle:true,observationSize:19704,framesPerAction:15,switchCooldownFrames:0,manualRetarget:true,allLifts:true,ready:true};
  device.lost.then(info=>{window.bogeoBrowserPolicy={request:async()=>{throw Error(`GPU connection lost: ${info.message}`);}};});
  const script=document.createElement('script');script.src=new URL('./bogeo-driver.js',import.meta.url).href;
  script.onload=()=>status.remove();script.onerror=()=>{status.textContent='Could not load the game controls.';};document.body.append(script);
}catch(error){status.textContent=`Cannot start: ${error.message}`;console.error(error);}
