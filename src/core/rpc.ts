// Transport des requêtes vers le noyau Rust.
//
// Format binaire commun à Tauri et au harnais de test (voir
// crates/swiftpad-core/src/rpc.rs) : u32 LE longueur de l'en-tête JSON,
// l'en-tête {cmd, args}, puis une charge utile brute facultative. Les textes
// des documents voyagent ainsi en octets UTF-8, sans échappement JSON.

export class RpcError extends Error {
  readonly code: string;
  readonly detail: any;
  constructor(code: string, message: string, detail?: any) {
    super(message);
    this.code = code;
    this.detail = detail ?? null;
  }
}

export interface Reply<T = any> {
  json: T;
  bytes: Uint8Array | null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

type Transport = (body: Uint8Array) => Promise<ArrayBuffer>;
let transport: Transport | null = null;

function tauriTransport(): Transport {
  const invoke = window.__TAURI__!.core.invoke;
  return async (body) => {
    try {
      return await invoke<ArrayBuffer>('rpc', body);
    } catch (e) {
      throw new RpcError('ipc', `Communication interne impossible : ${String(e)}`);
    }
  };
}

function httpTransport(): Transport {
  const token = new URLSearchParams(location.search).get('token') ?? '';
  return async (body) => {
    let res: Response;
    try {
      res = await fetch('/rpc', { method: 'POST', headers: { 'X-SwiftPad-Token': token }, body: body as BodyInit });
    } catch (e) {
      throw new RpcError('ipc', `Harnais injoignable : ${String(e)}`);
    }
    if (!res.ok) throw new RpcError('ipc', `Harnais : HTTP ${res.status}`);
    return res.arrayBuffer();
  };
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && !!window.__TAURI__;
}

function getTransport(): Transport {
  if (!transport) transport = isTauri() ? tauriTransport() : httpTransport();
  return transport;
}

export function encodeRequest(cmd: string, args: object, payload?: Uint8Array): Uint8Array {
  const head = encoder.encode(JSON.stringify({ cmd, args }));
  const out = new Uint8Array(4 + head.length + (payload?.length ?? 0));
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  if (payload) out.set(payload, 4 + head.length);
  return out;
}

export function decodeReply(buf: ArrayBuffer): Reply {
  const u8 = new Uint8Array(buf);
  const kind = u8[0];
  if (kind === 0) {
    return { json: JSON.parse(decoder.decode(u8.subarray(1))), bytes: null };
  }
  if (kind === 1) {
    const n = new DataView(buf).getUint32(1, true);
    const head = JSON.parse(decoder.decode(u8.subarray(5, 5 + n)));
    return { json: head, bytes: u8.subarray(5 + n) };
  }
  let err: any = null;
  try {
    err = JSON.parse(decoder.decode(u8.subarray(1)));
  } catch {
    /* réponse illisible */
  }
  throw new RpcError(err?.code ?? 'internal', err?.message ?? 'Réponse invalide du noyau.', err?.detail);
}

/** Appel d'une commande du noyau. */
export async function call<T = any>(cmd: string, args: object = {}, payload?: Uint8Array): Promise<Reply<T>> {
  const buf = await getTransport()(encodeRequest(cmd, args, payload));
  return decodeReply(buf) as Reply<T>;
}

/** Appel ne renvoyant que du JSON. */
export async function rpc<T = any>(cmd: string, args: object = {}, payload?: Uint8Array): Promise<T> {
  return (await call<T>(cmd, args, payload)).json;
}

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Message lisible pour une erreur quelconque. */
export function errorMessage(e: unknown): string {
  if (e instanceof RpcError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function errorCode(e: unknown): string {
  return e instanceof RpcError ? e.code : 'internal';
}
