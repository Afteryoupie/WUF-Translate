import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

test('WUF public identity has a new RSA key and matching native-host origin', () => {
  const identity = JSON.parse(readFileSync(new URL('../wuf-src/identity.json', import.meta.url)));
  const der = Buffer.from(identity.key, 'base64');
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  assert.equal(key.asymmetricKeyType, 'rsa');
  assert.equal(key.asymmetricKeyDetails.modulusLength, 2048);
  const expected = [...createHash('sha256').update(der).digest('hex').slice(0, 32)]
    .map(n => String.fromCharCode(97 + parseInt(n, 16))).join('');
  assert.equal(identity.extensionId, expected);
  assert.deepEqual(identity.allowedOrigins, [`chrome-extension://${expected}/`]);
  assert.equal(identity.nativeHost, 'com.wuf_translate.watchdog');
  const legacy = JSON.parse(readFileSync(new URL('./fixtures/legacy-public-key.json', import.meta.url)));
  assert.notEqual(identity.key, legacy.key);
});
