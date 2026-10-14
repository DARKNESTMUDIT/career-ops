import {spawn} from 'node:child_process';

// A process-group deadline also stops browser/model grandchildren on this Mac.
// Unlike Promise.race, timed-out work cannot keep modifying the queue afterward.
export function boundedProcess(command,args,{cwd,env=process.env,timeoutMs=60000,maxBytes=8*1024*1024}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',failure;
    const stop=reason=>{
      failure=reason;
      try {process.platform==='win32'?child.kill('SIGKILL'):process.kill(-child.pid,'SIGKILL');}catch{}
    };
    const timer=setTimeout(()=>stop('Execution deadline exceeded'),timeoutMs);
    child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>maxBytes)stop('Command output exceeded limit');});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000);});
    child.once('error',()=>{clearTimeout(timer);reject(new Error('Command could not start'));});
    child.once('close',code=>{
      clearTimeout(timer);
      if(failure)return reject(new Error(failure));
      if(code!==0){const error=new Error(`Command failed (${code})`);error.stderr=stderr;error.stdout=stdout;error.exitCode=code;return reject(error);}
      resolve({stdout,stderr});
    });
  });
}
