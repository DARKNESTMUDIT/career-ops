import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {reconnectGmail,GMAIL_SCOPES} from '../autonomous/gmail-auth.mjs';

const approved='candidate@example.invalid';
const original={client_id:'existing.apps.googleusercontent.com',client_secret:'synthetic-client-secret',refresh_token:'old-synthetic-refresh',email:approved,scopes:GMAIL_SCOPES};
function fixture(overrides={}) {
  const calls=[],writes=[],authorizations=[];
  return {calls,writes,authorizations,options:{root:'/synthetic/no-client-json',email:approved,timeoutMs:2000,
    store:async(root,operation,value)=>{calls.push({root,operation});if(operation==='get')return {...original};writes.push(value);},
    fetcher:async(url,options)=>{
      calls.push({url,options});
      if(url==='https://oauth2.googleapis.com/token') {
        assert.equal(options.method,'POST');
        assert.equal(options.body.get('client_id'),original.client_id);
        assert.equal(options.body.get('client_secret'),original.client_secret);
        assert.equal(options.body.get('grant_type'),'authorization_code');
        assert.equal(options.body.get('code'),'synthetic-code');
        const request=new URL(authorizations[0]);
        assert.equal(createHash('sha256').update(options.body.get('code_verifier')).digest('base64url'),request.searchParams.get('code_challenge'));
        return {ok:true,json:async()=>({access_token:'new-synthetic-access',refresh_token:'new-synthetic-refresh',scope:GMAIL_SCOPES.join(' ')})};
      }
      assert.equal(url,'https://gmail.googleapis.com/gmail/v1/users/me/profile');
      assert.equal(options.headers.Authorization,'Bearer new-synthetic-access');
      return {ok:true,json:async()=>({emailAddress:approved})};
    },
    onAuthorize:async url=>{
      authorizations.push(url);
      const request=new URL(url);
      assert.equal(request.origin,'https://accounts.google.com');
      assert.equal(request.searchParams.get('client_id'),original.client_id);
      assert.deepEqual(request.searchParams.get('scope').split(' '),GMAIL_SCOPES);
      assert.equal(request.searchParams.get('code_challenge_method'),'S256');
      assert.equal(request.searchParams.get('login_hint'),approved);
      assert.equal(request.searchParams.get('access_type'),'offline');
      const callback=new URL(request.searchParams.get('redirect_uri'));
      assert.equal(callback.hostname,'127.0.0.1');
      callback.search=new URLSearchParams({state:'wrong-state',code:'synthetic-code'});
      assert.equal((await fetch(callback)).status,400);
      callback.searchParams.set('state',request.searchParams.get('state'));
      assert.equal((await fetch(callback)).status,200);
    },...overrides}};
}

test('reconnect reuses exact stored Desktop client and PKCE without client JSON or returned credentials',async()=>{
  const f=fixture(),result=await reconnectGmail(f.options);
  assert.deepEqual(result,{connected:true,email:approved,storage:'macOS Keychain'});
  assert.deepEqual(f.writes,[{...original,refresh_token:'new-synthetic-refresh'}]);
  assert.equal(f.calls.filter(call=>call.operation==='get').length,1);
  assert.equal(f.calls.filter(call=>call.operation==='put').length,1);
  assert.equal(f.calls.filter(call=>call.url).length,2);
  for(const secret of [original.client_secret,original.refresh_token,'new-synthetic-refresh','new-synthetic-access'])assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!f.authorizations[0].includes(original.client_secret));
});

test('reconnect refuses absent stored client or sender mismatch before authorization or network',async()=>{
  for(const record of [null,{}, {...original,email:'other@example.invalid'}, {...original,client_id:undefined}, {...original,client_id:'invalid'}, {...original,client_secret:''}]) {
    let contacts=0;
    const f=fixture({store:async(_root,operation)=>{assert.equal(operation,'get');return record;},onAuthorize:async()=>{contacts++;},fetcher:async()=>{contacts++;}});
    await assert.rejects(reconnectGmail(f.options),/Stored Gmail|Stored OAuth/);
    assert.equal(contacts,0);
  }
});

test('reconnect rejects a different verified Google mailbox without overwriting the Keychain record',async()=>{
  const f=fixture();const fetcher=f.options.fetcher;
  f.options.fetcher=async(url,options)=>url.includes('/profile')?{ok:true,json:async()=>({emailAddress:'other@example.invalid'})}:fetcher(url,options);
  await assert.rejects(reconnectGmail(f.options),/does not match the approved sender/);
  assert.deepEqual(f.writes,[]);
});

test('reconnect requires both send/read-only scopes and a replacement refresh token',async()=>{
  for(const token of [{access_token:'synthetic',refresh_token:'synthetic',scope:GMAIL_SCOPES[0]},{access_token:'synthetic',scope:GMAIL_SCOPES.join(' ')}]) {
    const f=fixture({fetcher:async()=>({ok:true,json:async()=>token})});
    await assert.rejects(reconnectGmail(f.options),/Both requested Gmail scopes and offline access/);
    assert.deepEqual(f.writes,[]);
  }
});
