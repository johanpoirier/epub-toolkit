import {all, Promise} from 'rsvp';
import {isEpubFixedLayout, isEmpty} from './utils';
import ZipEpub from './ZipEpub';
import WebEpub from './WebEpub';
import Lcp from './Lcp';
import JSZip from 'jszip';
import cheerio from 'cheerio';
import {getLcpLicense} from "./utils/zipTools";

const UTF8 = 'utf-8';


const BYTES_FORMAT = 'uint8array';

const EPUB_FILE_MIME_TYPE = 'application/epub+zip';
const ASCM_XML_ROOT_TAG = 'fulfillmentToken';

const PROTECTION_METHOD = {
  ADOBE_DRM: 'http://ns.adobe.com/adept',
  ADOBE_FONT: 'http://ns.adobe.com/pdf/enc#RC',
  LCP: 'license.lcpl#/encryption/content_key',
  IDPF_FONT: 'http://www.idpf.org/2008/embedding',
  UNKNOWN: 'unknown'
};

const LCP_PROTECTION_TYPE = 'http://readium.org/2014/01/lcp#EncryptedContentKey';

class Explorer {

  /**
   * @param data
   * @param license
   * @param keys
   * @returns {Promise<ZipEpub>}
   */
  async loadFromBinary(data, license = null, keys = []) {
    const zip = await JSZip.loadAsync(data);
    return new ZipEpub(zip, license, keys);
  }

  /**
   * @param data
   * @param license
   * @param keys
   * @returns {Promise<ZipEpub>}
   */
  async loadFromBase64(data, license = null, keys = []) {
    const zip = await JSZip.loadAsync(data, {base64: true});
    return new ZipEpub(zip, license, keys);
  }

  /**
   * @param url
   * @param license
   * @param keys
   * @returns {Promise<WebEpub>}
   */
  async loadFromWebPubUrl(url, license = null, keys = []) {
    if (url[url.length - 1] === '/') {
      url = url.substr(0, url.length - 1);
    }
    return new WebEpub(url, license, keys);
  }

  /**
   * Extracts cover image raw data from epub data
   *
   * @param {UInt8Array} epubData
   * @return {Promise} A promise that resolves with the image data
   */
  cover(epubData) {
    return getZipFromData(epubData).then(getCoverData);
  }

  /**
   * Extracts LCP license from epub
   *
   * @param epubData: epub binary data
   * @return {Promise} A promise that resolves with the parsed LCP license
   */
  async lcpLicense(epubData) {
    const zip = await getZipFromData(epubData);
    return getLcpLicense(zip);
  }

  /**
   * Extracts protections from epub
   *
   * @param {UInt8Array} epubData: epub binary data
   */
  protections(epubData) {
    return getZipFromData(epubData)
      .then(getProtections);
  }

  /**
   *
   * @param epub
   * @returns {*}
   */
  isValid(epubData) {
    return testEpubFileValidity(epubData);
  }

  /**
   *
   * @param epubData
   * @returns {*}
   */
  isAscmFile(epubData) {
    return isAscmFile(epubData);
  }

  /**
   *
   * @param epubData
   * @param license
   * @param userKey
   * @returns {Promise<*>}
   */
  async decipher(epubData, license, userKey) {
    const zip = await getZipFromData(epubData);
    license = license || await getLcpLicense(zip);
    const protectedFileMap = await getProtectedFiles(zip);

    const promises = Object.keys(zip.files).map(async filePath => {
      const protection = protectedFileMap[filePath];
      if (protection && protection.type === LCP_PROTECTION_TYPE) {
        try {
          const data = await getFile(zip, filePath, BYTES_FORMAT);
          return {
            path: filePath,
            data: await Lcp.decipherFile(data, protectedFileMap[filePath], license, userKey)
          }
        } catch (error) {
          console.warn(`${filePath} was not deciphered`, error);
          return null;
        }
      }
      return {
        path: filePath,
        data: await zip.file(filePath).async(BYTES_FORMAT)
      };
    });
    const epubFiles = await all(promises, 'decipher-files');

    const newZip = new JSZip();
    await all(epubFiles.map(file => {
      if (!file) {
        return;
      }
      if (file.path === 'META-INF/encryption.xml') {
        return;
      }
      console.info('adding to zip', file.path);
      return newZip.file(file.path, file.data);
    }), 'add-files-to-zip');

    return newZip.generateAsync({type: 'arraybuffer'});
  }
}

export default new Explorer();

const base64regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;

function getZipFromData(data) {
  const options = {};
  if (typeof data === 'string' && base64regex.test(data.slice(0, 64))) {
    options.base64 = true;
  }
  return JSZip.loadAsync(data, options);
}

async function getSpines(zip, license, keys = null, toc = null, shouldAnalyzeSpines = true) {
  if (isEmpty(license)) {
    license = await getLcpLicense(zip);
  }

  // finding spines in .opf
  const {basePath, opf} = await getOpfContent(zip);
  const validSpines = [];
  opf('spine > itemref').each((index, element) => {
    const spine = cheerio(element);
    const idref = spine.attr('idref');
    const item = opf(`manifest > item[id="${idref}"]`);
    if (isEmpty(item)) {
      return;
    }
    const href = item.attr('href');
    const validSpine = {
      idref,
      href,
      path: makeAbsolutePath(`${basePath}${href}`)
    };

    const spineProperties = spine.attr('properties');
    if (!isEmpty(spineProperties)) {
      validSpine.spread = spineProperties;
    }

    validSpines.push(validSpine);
  });

  const protectedFiles = await getProtectedFiles(zip);
  for (let spineIndex = 0; spineIndex < validSpines.length; spineIndex++) {
    const spine = validSpines[spineIndex];
    spine.cfi = `/6/${2 + spineIndex * 2}`;
    spine.protection = protectedFiles[spine.path];
  }

  if (shouldAnalyzeSpines) {
    const userKey = await Lcp.getValidUserKey(license, keys);
    const promises = [];
    validSpines.forEach(spine => promises.push(analyzeSpine.call(this, zip, spine, license, userKey, toc)));
    return all(promises, 'spines analysis');
  }

  return validSpines;
}



function getCoverData(zip) {
  return getCoverPath(zip)
    .then(coverFilePath => getFile(zip, coverFilePath, BYTES_FORMAT));
}

async function getProtections(zip) {
  try {
    const file = await getFile(zip, 'META-INF/encryption.xml', STRING_FORMAT);
    const xmlFile = parseXml(file);

    const resourceProtections = {};
    xmlFile('EncryptedData').each((index, element) => {
      let resourceProtection = PROTECTION_METHOD.UNKNOWN;

      const encryptionMethod = xmlFile('EncryptionMethod', element);
      const retrievalMethod = xmlFile('KeyInfo > RetrievalMethod', element);
      const keyResource = xmlFile('KeyInfo > resource', element);

      if (retrievalMethod) {
        resourceProtection = retrievalMethod.attr('URI');
      } else if (keyResource) {
        resourceProtection = keyResource.attr('xmlns');
      } else {
        resourceProtection = encryptionMethod.attr('Algorithm');
      }
      resourceProtections[resourceProtection] = true;
    });
    return Object.keys(resourceProtections);
  } catch (error) {
    console.warn(error);
    return [];
  }
}

async function getProtectedFiles(zip) {
  let xmlFile;
  try {
    xmlFile = await getFile(zip, 'META-INF/encryption.xml', STRING_FORMAT);
  } catch (error) {
    return {};
  }

  try {
    xmlFile = parseXml(xmlFile);
    const resources = {};
    xmlFile('EncryptedData').each((index, element) => {
      const uri = xmlFile('CipherData > CipherReference', element).attr('URI');
      const algorithm = xmlFile('EncryptionMethod', element).attr('Algorithm');
      const compression = xmlFile('Compression', element);

      let type = PROTECTION_METHOD.UNKNOWN;
      const retrievalMethod = xmlFile('KeyInfo > RetrievalMethod', element);
      if (retrievalMethod.length > 0) {
        type = retrievalMethod.attr('Type');
      }
      const keyInfo = xmlFile('KeyInfo > resource', element);
      if (keyInfo.length > 0) {
        type = keyInfo.attr('xmlns');
      }

      resources[makeAbsolutePath(decodeURIComponent(uri))] = {
        algorithm,
        compressionMethod: compression ? parseInt(compression.attr('Method'), 10) : 0,
        originalLength: compression ? parseInt(compression.attr('OriginalLength'), 10) : 0,
        type
      };
    });

    return resources;
  } catch (error) {
    console.warn(error);
    throw error;
  }
}

function testEpubFileValidity(epubData) {
  return !isAscmFile(epubData) && isZipFile(epubData);
}

function isAscmFile(epubData) {
  if (!TextDecoder) {
    console.warn('TextDecoder Object is not available');
    return false;
  }

  return new TextDecoder(UTF8).decode(epubData.slice(1, 17)) === ASCM_XML_ROOT_TAG;
}

function isZipFile(epubData) {
  if (!TextDecoder) {
    console.warn('TextDecoder Object is not available');
    return false;
  }

  const fileStartChunk = new TextDecoder('utf-8').decode(epubData.slice(0, 100));
  return fileStartChunk.indexOf(EPUB_FILE_MIME_TYPE) !== -1;
}
