import { readFile } from 'node:fs/promises';
import { verifyLocalHandoff } from './handoffs.mjs';

const args=process.argv.slice(2);
try {
  if(args.length!==4||args[0]!=='--project'||args[2]!=='--input')throw new Error('Usage: node handoff-verify.mjs --project ABSOLUTE-PROJECT --input MANIFEST.json');
  const text=await readFile(args[3],'utf8');if(Buffer.byteLength(text)>100000)throw new Error('Manifest file too large');
  const result=await verifyLocalHandoff({project:args[1],manifest:JSON.parse(text)});
  console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
} catch(error){console.error('Handoff verification failed: '+error.message);process.exitCode=1;}
