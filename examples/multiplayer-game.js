// A registered launch and YOUR creator-operated server are prerequisites.
import {createSpawnMultiplayerClient} from '@spawn/sdk/multiplayer';
import {createSpawnStartup} from '@spawn/sdk/startup';
const serverOrigin='https://game.example';
const spawn=createSpawnMultiplayerClient({platformOrigin:'https://spawn.family',serverOrigin});
let currentSocket=null;
export const startup=createSpawnStartup({connect:async signal=>{
 await spawn.ready();spawn.reportConnection('connecting');
 const {ticket}=await spawn.requestGrant();
 if(signal.aborted)throw new Error('Connection cancelled.');
 const url=new URL('/multiplayer',serverOrigin);url.protocol='wss:';
 return new Promise((resolve,reject)=>{
  const socket=new WebSocket(url);currentSocket=socket;let admitted=false;
  const close=()=>socket.close();signal.addEventListener('abort',close,{once:true});
  // auth/hello are THIS EXAMPLE'S game protocol, not a Spawn server API.
  socket.onopen=()=>socket.send(JSON.stringify({type:'auth',ticket}));
  socket.onmessage=event=>{
   if(admitted||signal.aborted||typeof event.data!=='string'||event.data.length>4096)return;
   let message;try{message=JSON.parse(event.data);}catch{socket.close();return;}
   if(message.type==='hello'&&typeof message.user?.id==='string'&&message.user.id){
    // The creator server must have verified and consumed the signed grant.
    admitted=true;signal.removeEventListener('abort',close);
    spawn.reportConnection('ready');resolve(message.user);
   }else if(message.type==='error'){reject(new Error('Game admission failed.'));socket.close();}
  };
  socket.onerror=()=>{reject(new Error('Game connection unavailable.'));socket.close();};
  socket.onclose=()=>{
   signal.removeEventListener('abort',close);
   reject(new Error('Game connection closed.'));
   if(currentSocket===socket){currentSocket=null;startup.invalidate();spawn.reportConnection('disconnected');}
  };
 });
}});
// Subscribe to startup.state; enable every play mode only while ready.
// Call startup.connect() on boot/Retry. Implement gameplay and disconnect
// recovery separately; this minimal example starts no round automatically.
// Never log the proof or put it in URLs. Server authority is always required.
window.addEventListener('pagehide',()=>{startup.dispose();currentSocket?.close();spawn.dispose();},{once:true});
