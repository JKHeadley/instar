// All child egress is denied except a loopback CONNECT proxy that admits ONLY
// the isolated public relay. Host routing/firewall and other agents are untouched.
import fs from 'node:fs';import http from 'node:http';import net from 'node:net';
import {spawn} from 'node:child_process';
const [file,mode='cycle']=process.argv.slice(2),c=JSON.parse(fs.readFileSync(file,'utf8')),relay=new URL(c.relayUrl);
if(!['cycle','repair-cycle'].includes(mode))throw new Error('test-cycle-mode-refused');
if(!/^throwaway-recovery-[a-z0-9-]+$/.test(c.agentId)||relay.protocol!=='https:'||relay.port||!relay.hostname.endsWith('.dawn-tunnel.dev'))throw new Error('isolated-test-relay-required');
const sockets=new Set(),proxy=http.createServer((_req,res)=>{res.writeHead(403);res.end();});
proxy.on('connect',(req,client,head)=>{
 if(req.url!==relay.hostname+':443'){client.destroy();return;}
 const upstream=net.connect({host:relay.hostname,port:443});
 for(const s of [client,upstream]){sockets.add(s);s.once('close',()=>sockets.delete(s));s.on('error',()=>{client.destroy();upstream.destroy();});}
 upstream.once('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);upstream.pipe(client);client.pipe(upstream);});
});
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const port=proxy.address().port,profile=`(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:${port}") (literal "/private/var/run/mDNSResponder") (control-name "com.apple.netsrc"))`;
console.log(JSON.stringify({isolation:'all-direct-egress-denied',proxyOnlyDestination:relay.hostname+':443'}));
const child=spawn('/usr/bin/sandbox-exec',['-p',profile,process.execPath,new URL('./'+mode+'.mjs',import.meta.url).pathname,file,'relay','ssh-blocked'],{stdio:'inherit',env:{...process.env,NODE_USE_ENV_PROXY:'1',HTTPS_PROXY:`http://127.0.0.1:${port}`,HTTP_PROXY:`http://127.0.0.1:${port}`,NO_PROXY:''}});
try{process.exitCode=await new Promise((resolve,reject)=>{child.once('exit',code=>resolve(code??1));child.once('error',reject);});}
finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>proxy.close(resolve));}
