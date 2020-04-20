import pako from 'pako';
const forge = require('../vendor/forge.min');
import {isEmpty} from './utils';

const IV_BYTES_SIZE = 16;
const CBC_CHUNK_SIZE = 1024 * 32; // best perf with 32ko chunks
const ZIP_COMPRESSION_METHOD = 8;

class Lcp {
  async decipherTextFile() {
  }

  /**
   * Deciphers data and outputs ArrayBuffer
   *
   * @param fileData
   * @param protection
   * @param license
   * @param key
   * @returns {Promise<ArrayBuffer>}
   */
  async decipherFile(fileData, protection, license, key) {
    const decipheredData = await decipherData(fileData, license, key);
    if (!isEmpty(protection) && protection['compressionMethod'] === ZIP_COMPRESSION_METHOD) {
      return unzipToArrayBuffer(decipheredData);
    }

    return decipheredData;
  }

  getValidUserKey() {
  }
}

export default new Lcp();


async function decipherData(fileData, license, userKey) {
  const contentKey = await getContentKey(license, userKey);
  return decipher(contentKey, fileData, 'arraybuffer');
}

function decipher(key, encryptedData, dataType) {
  if (dataType === 'arraybuffer') {
    return aesDecipherArrayBuffer(key, encryptedData);
  }
  if (dataType === 'blob') {
    return blobToArrayBuffer(encryptedData)
      .then(arrayBuffer => aesDecipherArrayBuffer(key, arrayBuffer));
  }
  return aesDecipherBinary(key, encryptedData);
}

function getContentKey(license, userKey) {
  const contentKeyEncrypted = forge.util.decode64(license.encryption.content_key.encrypted_value);
  return decipher(forge.util.hexToBytes(userKey), contentKeyEncrypted);
}

function aesDecipherArrayBuffer(key, encryptedArrayBuffer) {
  try {
    const decipher = forge.cipher.createDecipher('AES-CBC', key);
    decipher.start({iv: forge.util.createBuffer(encryptedArrayBuffer.slice(0, IV_BYTES_SIZE)).data});

    const length = encryptedArrayBuffer.length || encryptedArrayBuffer.byteLength;
    const chunkSize = CBC_CHUNK_SIZE;
    let index = IV_BYTES_SIZE;
    let realSize = 0;

    const decryptedBuffer = new Uint8Array(length - IV_BYTES_SIZE);
    do {
      const bytes = decipher.output.getBytes();
      if (bytes.length > 0) {
        decryptedBuffer.set(binary2BinArray(bytes), index - CBC_CHUNK_SIZE - IV_BYTES_SIZE);
        realSize += bytes.length;
      }

      const buf = forge.util.createBuffer(encryptedArrayBuffer.slice(index, index + chunkSize));
      decipher.update(buf);
      index += chunkSize;
    } while (index < length);

    decipher.finish();

    const bytes = decipher.output.getBytes();
    realSize += bytes.length;
    decryptedBuffer.set(binary2BinArray(bytes), index - CBC_CHUNK_SIZE - IV_BYTES_SIZE);

    return decryptedBuffer.slice(0, realSize);
  } catch (e) {
    throw new Error('Key is invalid: ' + e.message);
  }
}

function aesDecipherBinary(key, encryptedBytes) {
  try {
    const decipher = forge.cipher.createDecipher('AES-CBC', key);
    decipher.start({iv: encryptedBytes.substring(0, IV_BYTES_SIZE)});

    const length = encryptedBytes.length;
    const chunkSize = CBC_CHUNK_SIZE;
    let index = IV_BYTES_SIZE;
    let decrypted = '';

    do {
      decrypted += decipher.output.getBytes();
      const buf = forge.util.createBuffer(encryptedBytes.substr(index, chunkSize));
      decipher.update(buf);
      index += chunkSize;
    } while (index < length);

    decipher.finish();
    decrypted += decipher.output.getBytes();

    return decrypted;
  } catch (e) {
    throw new Error('Key is invalid: ' + e.message);
  }
}

function blobToArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    const fileReader = new FileReader();
    fileReader.onload = function () {
      resolve(this.result);
    };
    fileReader.onerror = reject;
    fileReader.readAsArrayBuffer(blob);
  });
}

function binary2BinArray(binary) {
  const uint8Array = new Uint8Array(binary.length);
  for (let i = 0; i < uint8Array.length; i++) {
    uint8Array[i] = binary.charCodeAt(i);
  }
  return uint8Array;
}

/**
 * @param data ArrayBuffer
 * @returns {ArrayBuffer}
 */
function unzipToArrayBuffer(data) {
  return pako.inflateRaw(data, {to: 'array'});
}
