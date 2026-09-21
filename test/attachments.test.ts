import assert from 'node:assert/strict'
import test from 'node:test'
import type { AttachmentStore, ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { parseQQAttachments, prepareQQContent, qqImageUrl } from '../src/attachments.ts'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64')
const url = 'https://multimedia.nt.qq.com.cn/download?fileid=test'
const signal = () => new AbortController().signal
function store() {
  const saved: SaveImageAttachment[][] = []
  const service: Pick<AttachmentStore, 'imageLimits' | 'saveImages'> = {
    imageLimits: {maxImageBytes: 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 4096, maxImagePixels: 10000, maxImageDimension: 100, mediaTypes: ['image/png','image/jpeg','image/gif','image/webp']},
    async saveImages(images) {
      saved.push([...images])
      return images.map((image, i) => ({attachmentId:`image-${i}`,mediaType:image.mediaType,bytes:image.data.byteLength,width:1,height:1}) as ImageAttachmentRef)
    },
  }
  return {service,saved}
}
test('pure-image and multi-image messages become durable image blocks with captions preserved', async () => {
  const {service,saved} = store()
  const fetcher = (async () => new Response(png)) as typeof fetch
  const single = await prepareQQContent('', [{url}], service, {}, signal(), fetcher)
  assert.deepEqual(single.map(p=>p.type), ['text','image'])
  const multiple = await prepareQQContent('compare', [{url},{url}], service, {}, signal(), fetcher)
  assert.deepEqual(multiple.map(p=>p.type), ['text','image','image'])
  assert.deepEqual(multiple[0], {type:'text',text:'compare'})
  assert.deepEqual(saved.map(batch=>batch.length),[1,2])
  assert.deepEqual(saved[0][0].data,png)
})
test('QQ attachment metadata and scheme-less CDN URLs are retained', () => {
  assert.equal(qqImageUrl('//gchat.qpic.cn/pic').href, 'https://gchat.qpic.cn/pic')
  assert.equal(qqImageUrl('multimedia.nt.qq.com.cn/download').protocol, 'https:')
  assert.deepEqual(parseQQAttachments([{url,content_type:'image/png',size:30,filename:'a.png'}]),[{url,contentType:'image/png',size:30,filename:'a.png'}])
  assert.equal(parseQQAttachments([null])[0].url, '')
})
test('non-QQ URLs and redirects cannot reach local or arbitrary network addresses', async () => {
  for (const raw of ['https://127.0.0.1/image','file:///etc/passwd','http://gchat.qpic.cn/a','https://gchat.qpic.cn.evil.test/a','https://user:pass@gchat.qpic.cn/a','https://gchat.qpic.cn:8443/a']) assert.throws(()=>qqImageUrl(raw))
  let calls=0
  const fetcher=(async () => {calls++;return new Response(null,{status:302,headers:{location:'https://127.0.0.1/private'}})}) as typeof fetch
  await assert.rejects(prepareQQContent('',[{url}],store().service,{},signal(),fetcher),/QQ 图片地址/)
  assert.equal(calls,1)
})
test('count, advertised and streamed byte limits fail before storage', async () => {
  const {service,saved}=store()
  await assert.rejects(prepareQQContent('',[{url},{url}],service,{maxImagesPerMessage:1},signal()),/最多支持 1/)
  await assert.rejects(prepareQQContent('',[{url,size:2000}],service,{},signal()),/太大/)
  const advertised=(async()=>new Response(png,{headers:{'content-length':'2000'}})) as typeof fetch
  await assert.rejects(prepareQQContent('',[{url}],service,{},signal(),advertised),/太大/)
  const streamed=(async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1100));c.close()}}))) as typeof fetch
  await assert.rejects(prepareQQContent('',[{url}],service,{},signal(),streamed),/太大/)
  service.imageLimits.maxMessageImageBytes=png.length
  await assert.rejects(prepareQQContent('',[{url},{url}],service,{},signal(),(async()=>new Response(png)) as typeof fetch),/太大/)
  assert.equal(saved.length,0)
})
test('unsupported data, missing service, and download failures produce actionable errors', async () => {
  const {service,saved}=store()
  await assert.rejects(prepareQQContent('',[{url}],undefined,{},signal()),/图片存储服务/)
  await assert.rejects(prepareQQContent('',[{url}],service,{enableImages:false},signal()),/enableImages/)
  await assert.rejects(prepareQQContent('',[{url,contentType:'audio/silk'}],service,{},signal()),/语音/)
  await assert.rejects(prepareQQContent('',[{url}],service,{},signal(),(async()=>new Response('<html/>')) as typeof fetch),/附件格式/)
  await assert.rejects(prepareQQContent('',[{url}],service,{},signal(),(async()=>new Response(null,{status:403})) as typeof fetch),/过期/)
  assert.equal(saved.length,0)
})
test('cancellation never saves an image or admits a prompt', async () => {
  const {service,saved}=store()
  const controller=new AbortController()
  controller.abort()
  await assert.rejects(prepareQQContent('',[{url}],service,{},controller.signal),{name:'AbortError'})
  assert.equal(saved.length,0)
  assert.deepEqual(await prepareQQContent('hello',[],undefined,{},signal()),[{type:'text',text:'hello'}])
})
