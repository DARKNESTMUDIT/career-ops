// Native FormData may contain file references whose bytes are omitted from
// Chromium's protocol postData. Serialize the ACTUAL browser FormData through
// native Request once, then hand those same bytes to the original transport.
// Nothing is rebuilt from planned fields or from a PDF read after submission.
// This component does not fill, click, accept receipts or enable an adapter.
export async function installInternshalaNativeBody(page,submitUrl) {
  return page.evaluate(endpoint=>{
    if(new URL(endpoint).origin!==location.origin)throw Error('Same-origin native endpoint required');
    const NativeRequest=window.Request,NativeFormData=window.FormData;
    const nativeFetch=window.fetch.bind(window);
    const proto=XMLHttpRequest.prototype,open=proto.open,send=proto.send,setHeader=proto.setRequestHeader;
    const states=new WeakMap();
    const matches=(method,url)=>String(method).toUpperCase()==='POST' && new URL(url,location.href).href===endpoint;
    proto.open=function(method,url,async=true,...rest){
      const result=open.call(this,method,url,async,...rest);
      states.set(this,{method,url:new URL(url,location.href).href,async,contentType:false});return result;
    };
    proto.setRequestHeader=function(name,value){
      const result=setHeader.call(this,name,value),state=states.get(this);
      if(state && String(name).toLowerCase()==='content-type')state.contentType=true;
      return result;
    };
    proto.send=function(body){
      const state=states.get(this);
      if(!state || !matches(state.method,state.url) || !(body instanceof NativeFormData))return send.call(this,body);
      if(state.async===false || state.contentType){this.abort();throw Error('Native multipart transport cannot be safely normalized');}
      const xhr=this;
      (async()=>{
        const native=new NativeRequest(state.url,{method:state.method,body});
        const bytes=await native.arrayBuffer();
        setHeader.call(xhr,'Content-Type',native.headers.get('content-type'));
        send.call(xhr,bytes);
      })().catch(()=>{xhr.abort();console.error('career-ops: native multipart serialization failed; no retry');});
    };
    window.fetch=async function(input,init){
      const method=init?.method || (input instanceof NativeRequest ? input.method : 'GET');
      const url=input instanceof NativeRequest ? input.url : input;
      if(!matches(method,url) || !(init?.body instanceof NativeFormData))return nativeFetch(input,init);
      const native=new NativeRequest(input,init),bytes=await native.arrayBuffer();
      const normalized=new NativeRequest(native.url,{method:native.method,headers:native.headers,body:bytes,
        credentials:native.credentials,mode:native.mode,cache:native.cache,redirect:native.redirect,
        referrer:native.referrer,referrerPolicy:native.referrerPolicy,integrity:native.integrity,
        keepalive:native.keepalive,signal:native.signal});
      return nativeFetch(normalized);
    };
    return {installed:true,endpoint};
  },submitUrl);
}
