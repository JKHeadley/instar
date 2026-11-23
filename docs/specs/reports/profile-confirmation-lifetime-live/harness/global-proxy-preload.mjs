// Supported custom-dispatcher extension; only the isolated proof process loads it.
import {ProxyAgent,setGlobalDispatcher} from '/Users/dabombstudio/.instar/agents/echo/.worktrees/profile-confirm-lifetime/node_modules/undici/index.js';
setGlobalDispatcher(new ProxyAgent({uri:'http://127.0.0.1:4197',allowH2:false}));
