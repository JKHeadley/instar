/** Enforce the cap while reading, before any untrusted response can fill memory. */
export async function recoveryResponseJson(response: Response,maximum=262_144): Promise<any> {
  if(!response.body)throw new Error('recovery-response-empty');
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try {
    for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>maximum)throw new Error('recovery-response-too-large');chunks.push(item.value);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch(error){await reader.cancel();throw error;}finally{reader.releaseLock();}
}
