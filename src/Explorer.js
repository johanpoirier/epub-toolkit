import {all, hash, Promise} from 'rsvp';
import {convertUtf16Data, isEpubFixedLayout, isEmpty} from './utils';
import ZipEpub from './ZipEpub';
import WebEpub from './WebEpub';
import Lcp, {PROTECTION_METHODS} from './Lcp';
import JSZip from 'jszip';
import cheerio from 'cheerio';

import EpubCFI from './cfi/epubcfi';
import parseToc from './TocParser';
import {FileNotFoundError} from './errors';

const UTF8 = 'utf-8';
const UTF16BE = 'utf-16be';
const UTF16LE = 'utf-16le';
const UTF32BE = 'utf-32be';
const UTF32LE = 'utf-32le';

const UTF16BE_BOM_MARKER = '254-255';
const UTF16LE_BOM_MARKER = '255-254';
const UTF32BE_BOM_MARKER = '0-0-254-255';
const UTF32LE_BOM_MARKER = '255-254-0-0';

const BYTES_FORMAT = 'uint8array';
const STRING_FORMAT = 'string';
const ARRAYBUFFER_FORMAT = 'arraybuffer';

const EPUB_FILE_MIME_TYPE = 'application/epub+zip';
const ASCM_XML_ROOT_TAG = 'fulfillmentToken';

const EMPTY_ELEMENTS_COUNT = {characterCount: 0, imageCount: 0, videoCount: 0, totalCount: 0};

const PROTECTION_METHOD = {
  ADOBE_DRM: 'http://ns.adobe.com/adept',
  ADOBE_FONT: 'http://ns.adobe.com/pdf/enc#RC',
  LCP: 'license.lcpl#/encryption/content_key',
  IDPF_FONT: 'http://www.idpf.org/2008/embedding',
  UNKNOWN: 'unknown'
};

const LCP_PROTECTION_TYPE = 'http://readium.org/2014/01/lcp#EncryptedContentKey';

const TEXT_NODE = 3;

class Explorer {

  /**
   * @param data
   * @param license
   * @param userKey
   * @returns {Promise<ZipEpub>}
   */
  loadFromBinary(data, license = null, userKey = null) {
    return JSZip
      .loadAsync(data)
      .then(zip => new ZipEpub(zip, license, userKey));
  }

  /**
   * @param data
   * @returns {Promise<ZipEpub>}
   */
  loadFromBase64(data) {
    return JSZip
      .loadAsync(data, {base64: true})
      .then(zip => new ZipEpub(zip));
  }

  /**
   * @param url
   * @returns {Promise<WebEpub>}
   */
  async loadFromWebPubUrl(url) {
    return new WebEpub(url);
  }

  /**
   * Analyze and extracts infos from epub
   *
   * @param epub: epub filename or epub binary data
   * @param license
   * @param userKeys: user LCP keys
   * @return {Promise} A promise that resolves extra data from the epub
   */
  async analyze(epub, license, userKeys = null) {
    const zip = await getZipFromData(epub);

    const data = {};

    data.license = license || await getLcpLicense(zip);
    data.metadata = await getMetadata(zip);

    const isFixedLayout = isEpubFixedLayout(data.metadata.meta);

    data.toc = await getToc(zip);
    data.spines = await getSpines.call(this, zip, license, userKeys, data.toc, !isFixedLayout);

    await computeTocItemsSizes(data.toc);
    data.pagination = await generatePagination(data.toc, data.spines);

    return data;
  }

  /**
   * Get metadata from epub data
   *
   * @param {UInt8Array} epubData
   * @return {Promise} A promise that resolves with the metadata
   */
  metadata(epubData) {
    return getZipFromData(epubData).then(getMetadata);
  }

  /**
   * Get Table of Content from epub data
   *
   * @param {UInt8Array} epubData
   * @return {Promise} A promise that resolves with the table of content
   */
  toc(epubData) {
    return getZipFromData(epubData).then(getToc);
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
   * Get spines from epub data
   *
   * @param {UInt8Array} epubData
   * @param {Array} keys: User LCP keys
   * @return {Promise} A promise that resolves with an array of each spine character count
   */
  spines(epubData, keys = null) {
    return getZipFromData(epubData)
      .then(zip => getSpines.call(this, zip, keys));
  }

  /**
   * Extracts LCP license from epub
   *
   * @param {UInt8Array} epubData: epub binary data
   * @return {Promise} A promise that resolves with the parsed LCP license
   */
  lcpLicense(epubData) {
    return getZipFromData(epubData)
      .then(getLcpLicense);
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
   * Extracts protected file list from epub
   *
   * @param {UInt8Array} epubData: epub binary data
   */
  protectedFiles(epubData) {
    return getZipFromData(epubData)
      .then(getProtectedFiles);
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

function getFile(zip, path, format = STRING_FORMAT) {
  console.log('getting file', path);
  const zipFile = zip.file(normalizePath(path));
  if (!zipFile) {
    throw new FileNotFoundError(`file ${path} not found in zip`);
  }

  return zipFile.async(format);
}

async function getFileContent(zip, path, protection, license, key) {
  try {
    const format = isEmpty(protection) ? STRING_FORMAT : ARRAYBUFFER_FORMAT;
    let fileContent = await getFile(zip, path, format);

    if (isEmpty(protection)) {
      return fileContent;
    }

    if (protection.type === PROTECTION_METHODS.LCP) {
      fileContent = await Lcp.decipherTextFile(fileContent, protection, license, key);

      if (/html/.test(path)) {
        fileContent = convertUtf16Data(fileContent);
      }
    }

    return fileContent;

  } catch (error) {
    console.warn(`Can’t extract content of file at ${path}`, error);
    return '';
  }
}

async function getLcpLicense(zip) {
  try {
    const licenseJson = await getFile(zip, 'META-INF/license.lcpl');
    return JSON.parse(licenseJson);
  } catch {
    return null;
  }
}

function getOpfContent(zip) {
  let basePath;

  return getFile(zip, 'META-INF/container.xml', BYTES_FORMAT)
  // finding .opf path in container.xml
    .then(parseXml, error => console.error('Can not parse container.xml file', error))
    .then(document => {
      const opfFilePath = getOpfFilePath(document);
      basePath = getBasePath(opfFilePath);
      return getFile(zip, opfFilePath);
    })
    .then(opfXml => {
      return hash({
        basePath: basePath,
        opf: parseXml(opfXml.trim())
      });
    });
}

function getBasePath(contentFilePath) {
  const result = contentFilePath.match(/^(\w*)\/\w*\.opf$/);
  if (result) {
    return result[1] + '/';
  }
  return '';
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

function analyzeSpine(zip, spine, license, userKey, toc) {
  return getFileContent.call(this, zip, spine.path, spine.protection, license, userKey)
    .then(parseXml)
    .then(domContent => getSpineElementsCountInDom(domContent)
      .then(elementsCount => Object.assign(spine, elementsCount))
      .then(spine => enrichTocItems(toc, spine, domContent))
    )
    .catch(error => {
      console.warn(`Can’t analyze spine ${spine.path}`, error);
      return Object.assign(spine, EMPTY_ELEMENTS_COUNT);
    });
}

function getSpineElementsCountInDom(domContent) {
  return all([getCharacterCountInDom(domContent), getImageCountInDom(domContent), getVideoCountInDom(domContent)], 'spine analysis')
    .then(([characterCount, imageCount, videoCount]) => ({characterCount, imageCount, videoCount}))
    .then(estimateTotalCount)
    .catch(error => {
      console.warn('Content analyze failed', error);
      return EMPTY_ELEMENTS_COUNT;
    });
}

function getElementsCount(elements) {
  return all([getCharacterCount(elements), getImageCount(elements), getVideoCount(elements)], 'elements count')
    .then(([characterCount, imageCount, videoCount]) => ({characterCount, imageCount, videoCount}))
    .then(estimateTotalCount)
    .catch(error => {
      console.warn('Content analyze failed', error);
      return EMPTY_ELEMENTS_COUNT;
    });
}

function getCharacterCountInDom(domContent) {
  const elements = domContent('body *');
  return getCharacterCount(elements.toArray());
}

function getCharacterCount(elements) {
  return elements.reduce((total, el) => {
    const elementInnerContent = el.childNodes.filter(n => n.nodeType === TEXT_NODE).map(n => n.data).join('');
    return elementInnerContent.length + total;
  }, 0);
}

function getImageCountInDom(domContent) {
  const elements = domContent('img, svg image');
  return elements.length;
}

function getImageCount(elements) {
  const imageTagNames = ['img', 'image'];
  return elements.filter(el => imageTagNames.includes(el.tagName)).length;
}

function getVideoCountInDom(domContent) {
  const elements = domContent('video');
  return elements.length;
}

function getVideoCount(elements) {
  return elements.filter(el => el.tagName === 'video').length;
}

function enrichTocItems(items, spine, spineDomContent) {
  if (items) {
    const spineElements = spineDomContent('body *').toArray();

    findTocItemsInSpine(items, spine.href).map(item => {
      item.cfi = computeCfi(spine.cfi, spineDomContent, getHashFromHref(item.href));

      const itemElementId = spineElements.findIndex(el => el.id === getHashFromHref(item.href));
      if (itemElementId === -1) {
        item.positionInSpine = 0;
        return;
      }

      getElementsCount(spineElements.slice(0, itemElementId)).then(elementsCount => item.positionInSpine = elementsCount.totalCount / spine.totalCount);
    });
  }
  return spine;
}

function getHashFromHref(href) {
  const hrefSplit = href.split('#');
  return hrefSplit.length > 1 ? hrefSplit[1] : null;
}

function findTocItemsInSpine(items, href) {
  items = items || [];
  let matchingItems = items.filter(item => item.href.indexOf(href) === 0);
  items.forEach(item => {
    matchingItems = matchingItems.concat(findTocItemsInSpine(item.items, href))
  });
  return matchingItems;
}

function computeCfi(baseCfi, spineContent, hash) {
  if (hash) {
    const hashElement = spineContent(`#${hash}`);
    if (hashElement.length > 0) {
      return new EpubCFI(hashElement[0], baseCfi).toString();
    }
  }

  return `epubcfi(${baseCfi}!/4)`;
}

function getOpfFilePath(document) {
  return document('rootfile').attr('full-path');
}

function getMetadata(zip) {
  return getOpfContent(zip)
    .then(({opf}) => {
      const fixedMetadata = {};
      const metadata = opf('metadata > *');

      metadata.each((index, entry) => {
        const data = extractMetadataEntry(entry);
        fixedMetadata[data.key] = data.value;
      });
      return fixedMetadata;
    });
}

function extractMetadataEntry(entry) {
  const element = cheerio(entry);
  const tagName = entry.tagName;

  let key, value;

  if (tagName === 'meta') {
    key = element.attr('property');

    if (key) {
      value = element.text();
    } else {
      key = element.attr('name');
      value = element.attr('content');
    }
  } else {
    key = tagName;
    value = element.text();
  }

  return {key, value};
}

async function getToc(zip) {
  try {
    const {basePath, opf} = await getOpfContent(zip);

    let tocElement = opf('item[media-type="application/x-dtbncx+xml"]'); // epub 2
    if (isEmpty(tocElement)) {
      tocElement = opf('item[properties="nav"]'); // epub 3
    }
    if (isEmpty(tocElement)) {
      return null;
    }

    const tocFilename = tocElement.attr('href');
    const tocFile = await getFile(zip, basePath + tocFilename);
    return parseToc(basePath, parseXml(tocFile));
  } catch (error) {
    console.warn('failed to parse toc file', error);
    return null;
  }
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

function normalizePath(path) {
  const parts = path.split('/');

  return parts.reduce((path, part) => {
    if (part === '..') {
      return path.split('/').slice(0, -1).join('/');
    } else if (part === '.') {
      return path;
    }
    return `${path}${path.length === 0 ? '' : '/'}${part}`;
  });
}

function makeAbsolutePath(path) {
  if (path[0] === '/') {
    return path;
  }
  return `/${path}`;
}

function parseXml(data) {
  const xmlData = typeof data === 'string' ? data.trim() : bytesToString(data);
  return cheerio.load(xmlData, {xmlMode: true});
}

function bytesToString(uint8array) {
  const charset = detectCharset(uint8array);

  if (typeof TextDecoder === 'undefined') {
    return String.fromCharCode.apply(null, uint8array);
  }

  const textDecoder = new TextDecoder(charset);
  return textDecoder.decode(uint8array);
}

function detectCharset(uint8array) {
  const utf16Test = uint8array.subarray(0, 2).join('-');
  if (utf16Test === UTF16LE_BOM_MARKER) {
    return UTF16LE;
  } else if (utf16Test === UTF16BE_BOM_MARKER) {
    return UTF16BE;
  }

  const utf32Test = uint8array.subarray(0, 4).join('-');
  if (utf32Test === UTF32LE_BOM_MARKER) {
    return UTF32LE;
  } else if (utf32Test === UTF32BE_BOM_MARKER) {
    return UTF32BE;
  }

  return UTF8;
}

function estimateTotalCount(elementsCounts) {
  elementsCounts.totalCount = elementsCounts.characterCount + 300 * elementsCounts.imageCount + 300 * elementsCounts.videoCount;
  return elementsCounts;
}

function computeTocItemsSizes(items, basePosition = 0, baseSize = 1) {
  if (isEmpty(items)) {
    return;
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let sizeInSpine = baseSize;

    if (i + 1 < items.length) {
      const nextItem = items[i + 1];
      if (inSameSpine(item, nextItem)) {
        sizeInSpine = nextItem.positionInSpine - item.positionInSpine;
      }
    } else {
      sizeInSpine = baseSize + basePosition - item.positionInSpine;
    }

    if (sizeInSpine < 0) {
      console.warn('Can’t compute size of chapter in spine due to some weirdness in the ToC', item);
      sizeInSpine = 0;
    }

    computeTocItemsSizes(item.items, item.positionInSpine, sizeInSpine);

    item.percentageOfSpine = 100 * sizeInSpine;
  }
}

function inSameSpine(item1, item2) {
  return item1.href.split('#')[0] === item2.href.split('#')[0];
}

function generatePagination(tocItems, spines) {
  const totalCount = spines.reduce((total, spine) => total + spine.totalCount, 0);

  const elements = [];
  let spineIndex = 0, combinedSize = 0, maxLevel = 1;

  while (spineIndex < spines.length) {
    const spine = spines[spineIndex];
    const items = findTocItemsInSpine(tocItems, spine.href);
    maxLevel = items.reduce((max, item) => item.level > max ? item.level : max, maxLevel);

    let label;
    if (isEmpty(items)) {
      label = isEmpty(elements) ? spine.href.split('.')[0] : elements[spineIndex - 1].label;
    } else {
      label = items[0].label
    }

    const element = {
      items,
      label,
      percentageOfBook: 100 * spine.totalCount / totalCount,
      positionInBook: combinedSize
    };
    elements.push(element);

    combinedSize += element.percentageOfBook;
    spineIndex++;
  }

  return {
    totalCount,
    maxLevel,
    elements
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
