// Isolated TLS front and real Threadline relay. Test secret file stays on this host.
import fs from 'node:fs';import https from 'node:https';import http from 'node:http';
import {RelayServer} from '../../dist/threadline/relay/RelayServer.js';
const [file]=process.argv.slice(2);const config=JSON.parse(fs.readFileSync(file,'utf8'));
const relay=new RelayServer({host:'127.0.0.1',port:0,registryDataDir:config.dataDir});
relay.configureRecovery(new Map(Object.entries(config.authorities)));await relay.start();
const tls=https.createServer({key:fs.readFileSync(config.tlsKey),cert:fs.readFileSync(config.tlsCert)},(req,res)=>{
 const upstream=http.request({host:'127.0.0.1',port:relay.address.port,path:req.url,method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
 upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
});
await new Promise(resolve=>tls.listen(config.port,'0.0.0.0',resolve));console.log(JSON.stringify({relayPort:config.port,ready:true}));
for(const sig of ['SIGINT','SIGTERM'])process.once(sig,async()=>{await new Promise(resolve=>tls.close(resolve));await relay.stop();process.exit(0);});
