// Lets tests import the real api/*.js files without installing @vercel/kv, stripe, etc.
// Only the module *resolution* is stubbed; all app code under test is the real shipped source.
const STUBS = {
  '@vercel/kv': 'export const kv = { get: async()=>null, set: async()=>null, del: async()=>null, lpush: async()=>null, ltrim: async()=>null, lrange: async()=>[] };',
  '@vercel/blob': 'export const put = async()=>({url:"",pathname:""}); export const get = async()=>null; export const issueSignedToken = async()=>({}); export const presignUrl = async()=>({presignedUrl:""});',
  'stripe': 'export default class Stripe { constructor(){ this.customers={create:async()=>({})}; this.setupIntents={create:async()=>({})}; this.paymentMethods={list:async()=>({data:[]})}; this.paymentIntents={create:async()=>({})}; } }'
};

export async function resolve(specifier, context, next) {
  if (STUBS[specifier]) return { url: 'stub:' + specifier, shortCircuit: true };
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith('stub:')) {
    return { format: 'module', source: STUBS[url.slice(5)], shortCircuit: true };
  }
  return next(url, context);
}
