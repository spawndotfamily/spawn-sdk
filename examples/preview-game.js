// Bundle these imports locally. No API key belongs in the game.
import {createSpawnGameClient} from '@spawn/sdk';
import {createSpawnStartup} from '@spawn/sdk/startup';
const spawn=createSpawnGameClient({platformOrigin:'https://spawn.family'});
export const startup=createSpawnStartup({connect:()=>spawn.identity()});
// Subscribe your loading/error screen and keep ALL play modes disabled unless
// startup.state.status === 'ready'. Call startup.connect() on boot and Retry.
export async function loadProgress(){await startup.connect();return spawn.load('progress');}
export async function saveProgress(value,expectedVersion){await startup.connect();return spawn.save('progress',value,expectedVersion);}
export async function playerLabel(){const player=await startup.connect();return player.displayName;}
// Call startup.invalidate() on a runtime disconnect/revocation signal.
// Render labels with textContent. Identity/saves are not competitive proof.
window.addEventListener('pagehide',()=>{startup.dispose();spawn.dispose();},{once:true});
