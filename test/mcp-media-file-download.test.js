import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { validateMediaFileUrl, isPublicMediaAddress, createMediaFileDownloaderForTest } from '../src/mcp/media-file-download.js';

const url = 'https://files.oaiusercontent.com/file-synthetic?sig=private-test-value';
const file = { file_id: 'file-synthetic', download_url: url };
const publicDns = async () => [{address:'8.8.8.8',family:4}];
const png = Buffer.from([137,80,78,71,13,10,26,10,1]);
const jpeg = Buffer.from([255,216,255,1]);
const webp = Buffer.from('RIFF0000WEBPsynthetic');
function fixture({ body = png, status = 200, headers = {}, complete = true, resolve = publicDns, timeoutMs = 1000, hang = false } = {}) {
  const calls = [];
  const request = (target, options, callback) => {
    calls.push({target,options});
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const response = new PassThrough();
      response.statusCode = status; response.headers = headers; response.complete = complete;
      callback(response);
      if (!hang && !response.destroyed) response.end(body);
    });
    return req;
  };
  return { calls, download: createMediaFileDownloaderForTest({resolve,request,timeoutMs}) };
}

test('only the exact HTTPS source origin is accepted', () => {
  assert.equal(validateMediaFileUrl(url).hostname, 'files.oaiusercontent.com');
  for (const value of [undefined,'/etc/passwd','file:///etc/passwd','http://files.oaiusercontent.com/file',
    'https://files.oaiusercontent.com.evil.test/file','https://sub.files.oaiusercontent.com/file',
    'https://files.oaiusercontent.com./file','https://user:pass@files.oaiusercontent.com/file',
    'https://files.oaiusercontent.com:444/file','https://files.oaiusercontent.com/file#x',
    'https://127.0.0.1/file','https://files.oaiusercontent.com\\@evil.test/file']) assert.throws(() => validateMediaFileUrl(value),{status:400});
});

test('IP classification rejects private, reserved, mapped and tunnel addresses', () => {
  for (const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888']) assert.equal(isPublicMediaAddress(address),true,address);
  for (const address of ['0.0.0.0','10.1.2.3','127.0.0.1','100.64.0.1','169.254.169.254','172.16.0.1',
    '192.168.1.1','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255',
    '::1','::','fc00::1','fe80::1','::ffff:127.0.0.1','::ffff:7f00:1','2001:db8::1','2002:0808:0808::1','2001::1','not-an-ip']) assert.equal(isPublicMediaAddress(address),false,address);
});

test('all DNS answers are checked before a request and the accepted address is pinned', async () => {
  const denied = fixture({resolve:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]});
  await assert.rejects(denied.download(file),{status:503}); assert.equal(denied.calls.length,0);
  const f = fixture(); await f.download(file);
  const options = f.calls[0].options;
  assert.equal(options.agent,false); assert.equal(options.headers.Authorization,undefined);
  assert.equal(options.headers['Accept-Encoding'],'identity');
  options.lookup('files.oaiusercontent.com',{all:true},(error,addresses)=>assert.deepEqual(addresses,[{address:'8.8.8.8',family:4}]));
  options.lookup('files.oaiusercontent.com',{},(error,address,family)=>{assert.equal(address,'8.8.8.8');assert.equal(family,4);});
});

test('supported source bytes are preserved and hashed independently of declared MIME', async () => {
  for (const [body,mime] of [[png,'image/png'],[jpeg,'image/jpeg'],[webp,'image/webp']]) {
    const f = fixture({body}); const result = await f.download({...file,mime_type:mime});
    assert.deepEqual(result.bytes,body); assert.equal(result.mime,mime);
    assert.equal(result.sourceSha256,createHash('sha256').update(body).digest('hex'));
  }
  await assert.rejects(fixture().download({...file,mime_type:'image/jpeg'}),{status:400});
  await assert.rejects(fixture({body:Buffer.from('not an image')}).download(file),{status:400});
});

test('redirects, compression, incomplete and oversized responses fail without URL disclosure', async () => {
  for (const options of [{status:302,headers:{location:'http://127.0.0.1'}},{headers:{'content-encoding':'gzip'}},
    {headers:{'content-length':'524289'}},{headers:{'content-length':'9x'}},{headers:{'content-length':'10'}},
    {complete:false},{body:Buffer.alloc(0)},{body:Buffer.alloc(524289)}]) {
    const f = fixture(options);
    await assert.rejects(f.download(file),error=>{assert.equal(error.status,503);assert.doesNotMatch(error.message,/sig=|oaiusercontent|private-test/);return true;});
    assert.equal(f.calls.length,1);
  }
  const body = Buffer.concat([png,Buffer.alloc(524288-png.length)]);
  assert.equal((await fixture({body}).download(file)).bytes.length,524288);
});

test('overall deadline bounds DNS and streaming and late DNS cannot start a request', async () => {
  let finish;
  const f = fixture({resolve:()=>new Promise(resolve=>{finish=resolve;}),timeoutMs:10});
  await assert.rejects(f.download(file),{status:503});
  finish([{address:'8.8.8.8',family:4}]);
  await new Promise(resolve=>setImmediate(resolve)); assert.equal(f.calls.length,0);
  await assert.rejects(fixture({hang:true,timeoutMs:10}).download(file),{status:503});
});

test('unexpected transport failures are sanitized and test seam is test-only', async () => {
  const download = createMediaFileDownloaderForTest({resolve:publicDns,request:()=>{throw new Error(url);}});
  await assert.rejects(download(file),error=>{assert.equal(error.status,503);assert.doesNotMatch(error.message,/sig=|oaiusercontent/);return true;});
  const before = process.env.NODE_ENV;
  try { process.env.NODE_ENV='production'; assert.throws(()=>createMediaFileDownloaderForTest({resolve:publicDns,request:()=>{}}),TypeError); }
  finally { process.env.NODE_ENV=before; }
});

test('process-wide permits bound pre-stage downloads and release after failure', async () => {
  const f = fixture({hang:true,timeoutMs:20});
  const pending = Array.from({length:4},()=>assert.rejects(f.download(file),{status:503}));
  await assert.rejects(f.download(file),{status:503});
  await Promise.all(pending);
  assert.equal((await fixture().download(file)).mime,'image/png');
});
