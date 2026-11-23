// Isolated proof transport: CONNECT tunnels preserve Telegram TLS end to end.
// The fault closes real connections; it never fabricates platform responses.
import http from 'node:http';import net from 'node:net';import fs from 'node:fs';
const flag='/Users/dabombstudio/.instar/agents/echo/.instar/design-feedback-private/lifetime-proxy-block';const peers=new Set();let blocked=false;
const server=http.createServer((_req,res)=>{res.writeHead(405);res.end();});
server.on('connect',(req,client,head)=>{
 if(fs.existsSync(flag)){client.destroy();return;}
 const u=new URL('http://'+req.url);if(u.port!=='443'||!u.hostname||u.username||u.password){client.destroy();return;}
 const remote=net.connect(443,u.hostname);peers.add(client);peers.add(remote);
 const close=()=>{peers.delete(client);peers.delete(remote);client.destroy();remote.destroy();};
 remote.once('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)remote.write(head);client.pipe(remote);remote.pipe(client);});
 remote.on('error',close);client.on('error',close);remote.on('close',close);client.on('close',close);
});
const timer=setInterval(()=>{const next=fs.existsSync(flag);if(next&&!blocked){const count=peers.size;for(const p of peers)p.destroy();peers.clear();console.log(JSON.stringify({event:'network-fault-enabled',at:new Date().toISOString(),closedSockets:count}));}else if(!next&&blocked)console.log(JSON.stringify({event:'network-fault-cleared',at:new Date().toISOString()}));blocked=next;},100);
server.listen(4197,'127.0.0.1',()=>console.log(JSON.stringify({event:'connect-proxy-ready',port:4197,tls:'end-to-end',at:new Date().toISOString()})));
process.on('SIGTERM',()=>{clearInterval(timer);for(const p of peers)p.destroy();server.close(()=>process.exit(0));});
