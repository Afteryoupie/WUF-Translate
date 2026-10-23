// Public development identity only. No CRX signing private key is persisted.
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const { publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
});
const extensionId = [...createHash('sha256').update(publicKey).digest('hex').slice(0, 32)]
  .map(n => String.fromCharCode(97 + parseInt(n, 16))).join('');
const directory = new URL('../wuf-src/', import.meta.url);
mkdirSync(directory, { recursive: true });
// Refuse accidental rotation: Chrome IDs and native-host origins depend on this key.
writeFileSync(new URL('identity.json', directory), JSON.stringify({
  name: 'WUF Translate',
  key: publicKey.toString('base64'),
  extensionId,
  nativeHost: 'com.wuf_translate.watchdog',
  allowedOrigins: [`chrome-extension://${extensionId}/`],
}, null, 2) + '\n', { flag: 'wx' });
console.log(`WUF Translate: ${extensionId}`);
