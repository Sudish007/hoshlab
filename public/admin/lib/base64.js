// UTF-8 safe base64 for the GitHub contents API (which wants/returns base64
// and wraps its output every 60 characters). Imports nothing. (ai-batkahi copy.)
const CHUNK = 0x8000;

export function encodeBytes(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function encodeUtf8(text) {
  return encodeBytes(new TextEncoder().encode(String(text)));
}

export function decodeUtf8(b64) {
  try {
    const bin = atob(String(b64).replace(/\s+/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("decode");
  }
}
