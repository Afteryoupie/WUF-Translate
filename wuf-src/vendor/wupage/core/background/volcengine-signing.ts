import { sha256 } from "../shared/hash";

export async function signVolcengineTranslation(
  body: string, accessKeyId: string, secretAccessKey: string, region: string, now = new Date()
): Promise<Record<string, string>> {
  const dateTime = now.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  const date = dateTime.slice(0, 8);
  const digest = await sha256(body);
  const signedHeaders = "content-type;host;x-content-sha256;x-date";
  const canonicalHeaders = `content-type:application/json\nhost:translate.volcengineapi.com\nx-content-sha256:${digest}\nx-date:${dateTime}\n`;
  const canonical = ["POST", "/", "Action=TranslateText&Version=2020-06-01", canonicalHeaders, signedHeaders, digest].join("\n");
  const scope = `${date}/${region}/translate/request`;
  const toSign = ["HMAC-SHA256", dateTime, scope, await sha256(canonical)].join("\n");
  let key = new TextEncoder().encode(secretAccessKey);
  for (const part of [date, region, "translate", "request", toSign]) key = await hmac(key, part);
  const signature = Array.from(key, byte => byte.toString(16).padStart(2, "0")).join("");
  // The browser supplies Host; including a forbidden Host header in fetch is unnecessary.
  return { "Content-Type": "application/json", "X-Date": dateTime, "X-Content-Sha256": digest,
    Authorization: `HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

async function hmac(key: Uint8Array<ArrayBuffer>, text: string): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(text)));
}
