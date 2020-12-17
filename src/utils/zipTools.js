import {FileNotFoundError} from '../errors';
import {
  convertUtf16Data, EMPTY_ELEMENTS_COUNT, enrichTocItems, extractEncryptionsData,
  getBasePath, getDirPath,
  getOpfFilePath,
  getSpineElementsCountInDom,
  isEmpty,
  normalizePath,
  parseXml
} from './index';
import Lcp, {PROTECTION_METHODS} from '../Lcp';
import cheerio from 'react-native-cheerio';
import forge from '../../vendor/forge.min';

export const BYTES_FORMAT = 'uint8array';
export const STRING_FORMAT = 'string';
export const ARRAYBUFFER_FORMAT = 'arraybuffer';

const ENCRYPTION_METHODS = {
  IDPF: 'http://www.idpf.org/2008/embedding',
  ADOBE: 'http://ns.adobe.com/pdf/enc#RC',
  LCP: 'http://www.w3.org/2001/04/xmlenc#aes256-cbc'
};

export function getFile(zip, path, format = STRING_FORMAT) {
  const zipFile = zip.file(normalizePath(path));
  if (!zipFile) {
    throw new FileNotFoundError(`file ${path} not found in zip`);
  }

  return zipFile.async(format);
}

export async function getFileContent(zip, path, protection, license, key) {
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

export async function getProtectedFiles(zip) {
  try {
    const xmlData = await getFile(zip, 'META-INF/encryption.xml', STRING_FORMAT);
    const encryptionFile = parseXml(xmlData);

    return extractEncryptionsData(encryptionFile);
  } catch (error) {
    return {};
  }
}

export async function getCoverPath(zip) {
  const {basePath, opf} = await getOpfContent(zip);
  return getCoverFilePath(zip, opf, basePath);
}

function getCoverFilePath(zip, opf, basePath) {
  return new Promise((resolve, reject) => {
    // method 1: search for meta cover
    getCoverFilePathFromMetaCover(opf, basePath)
      .then(resolve)

      // method 2: search for an item in manifest with cover-image property
      .catch(() => getCoverFilePathFromManifestItem(opf, basePath))
      .then(resolve)

      // method 3 : search for a reference in the guide
      .catch(() => getCoverFilePathFromGuide(opf, basePath, zip))
      .then(resolve)

      // method 4 : browse 3 first items of the spine
      .catch(() => getCoverFilePathFromSpineItems(opf, basePath, zip))
      .then(resolve)

      .catch(reject);
  });
}

function getCoverFilePathFromMetaCover(opf, basePath) {
  return new Promise((resolve, reject) => {
    const coverItemRef = opf('metadata > meta[name="cover"]');
    if (!coverItemRef) {
      reject('no cover data found in metadata');
      return;
    }
    const coverItem = opf(`manifest > item[id='${coverItemRef.attr('content')}']`);
    if (isEmpty(coverItem)) {
      reject(`no item found in manifest with id ${coverItemRef.attr('content')}`);
      return;
    }
    resolve(basePath + coverItem.attr('href'));
  });
}

function getCoverFilePathFromManifestItem(opf, basePath) {
  return new Promise((resolve, reject) => {
    const coverItem = opf('manifest > item[properties="cover-image"]');
    if (isEmpty(coverItem)) {
      reject('no item with properties "cover-image" found in manifest');
      return;
    }
    resolve(basePath + coverItem.attr('href'));
  });
}

function getCoverFilePathFromGuide(opf, basePath, zip) {
  return new Promise((resolve, reject) => {
    const coverItem = opf('guide > reference[type="cover"]');
    if (isEmpty(coverItem)) {
      reject('no item of type "cover" found in guide');
      return;
    }

    const itemBasePath = basePath + getDirPath(coverItem.attr('href'));
    getFile(zip, basePath + coverItem.attr('href'))
      .then((coverPageXml) => {
        const coverPath = getImagePathFromXhtml(coverPageXml);
        if (coverPath) {
          resolve(itemBasePath + coverPath);
        } else {
          reject('no image url found in xhtml page');
        }
      });
  });
}

function getCoverFilePathFromSpineItems(opf, basePath, zip) {
  return new Promise((resolve, reject) => {
    const spineItems = opf('spine > itemref');
    if (isEmpty(spineItems)) {
      reject('no spine items found');
      return;
    }
    const idrefs = spineItems.slice(0, 3).map((index, item) => cheerio(item).attr('idref')).toArray();
    getCoverFilePathFromSpineItem(opf, basePath, zip, idrefs, resolve, reject);
  });
}

function getCoverFilePathFromSpineItem(opf, basePath, zip, idrefs, resolve, reject) {
  if (idrefs.length === 0) {
    reject('no spine item found with cover image inside');
    return;
  }

  const id = idrefs.shift();
  const item = opf(`manifest > item[id="${id}"]`);
  if (isEmpty(item) || !item.attr('href')) {
    reject(`no valid manifest item found with id ${id}`);
    return;
  }

  const spineItemBasePath = basePath + getDirPath(item.attr('href'));
  getFile(zip, basePath + item.attr('href')).then((itemXml) => {
    const coverPath = getImagePathFromXhtml(itemXml);
    if (coverPath) {
      resolve(spineItemBasePath + coverPath);
    } else {
      getCoverFilePathFromSpineItem(opf, basePath, zip, idrefs, resolve, reject);
    }
  });
}

function getImagePathFromXhtml(xhtml) {
  const coverPage = cheerio.load(xhtml);

  const coverImg = coverPage('img');
  if (!isEmpty(coverImg)) {
    return coverImg.attr('src');
  }

  const coverImage = coverPage('image');
  if (!isEmpty(coverImage)) {
    return coverImage.attr('href');
  }
}

export async function getLcpLicense(zip) {
  try {
    const licenseJson = await getFile(zip, 'META-INF/license.lcpl');
    return JSON.parse(licenseJson);
  } catch {
    return null;
  }
}

export function getOpfContent(zip) {
  let basePath;

  return getFile(zip, 'META-INF/container.xml', BYTES_FORMAT)
  // finding .opf path in container.xml
    .then(parseXml, error => console.error('Can not parse container.xml file', error))
    .then(document => {
      const opfFilePath = getOpfFilePath(document);
      basePath = getBasePath(opfFilePath);
      return getFile(zip, opfFilePath);
    })
    .then(opfXml => ({
      basePath,
      opf: parseXml(opfXml.trim())
    }));
}

export function analyzeSpineItem(zip, spine, license, userKey, toc) {
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

export async function getZipFileData(zipFile, contentType, protection, license, userKey) {
  const fetchMode = getFetchModeFromMimeType(contentType);
  if (!protection) {
    return zipFile.async(fetchMode);
  }
  switch (protection.algorithm) {
    case ENCRYPTION_METHODS.LCP:
      const decodedData = await Lcp.decipherFile(fetchMode, await zipFile.async('arraybuffer'), protection, license, userKey);
      if (fetchMode === 'text') {
        return fixDecodedTextData(decodedData, contentType);
      }
      return decodedData;

    case ENCRYPTION_METHODS.IDPF:
      // not implemented yet
      return zipFile.async(fetchMode);

    case ENCRYPTION_METHODS.ADOBE:
      // not implemented yet
      return zipFile.async(fetchMode);
  }
}


function getFetchModeFromMimeType(mimeType) {
  if (mimeType.indexOf('image') !== -1) {
    return 'nodebuffer';
  }
  if (mimeType.indexOf('video') !== -1) {
    return 'nodebuffer';
  }
  if (mimeType.indexOf('font') !== -1) {
    return 'nodebuffer';
  }
  if (mimeType.indexOf('pdf') !== -1) {
    return 'nodebuffer';
  }
  return 'text';
}

function fixDecodedTextData(decryptedBinaryData, mimeType) {
  if (typeof decryptedBinaryData !== 'string') {
    return decryptedBinaryData;
  }

  // BOM removal
  if (decryptedBinaryData.charCodeAt(0) === 0xFEFF) {
    decryptedBinaryData = decryptedBinaryData.substr(1);
  }
  let data = decryptedBinaryData.replace(/^ï»¿/, '');

  // convert UTF-8 decoded data to UTF-16 javascript string
  if (/html/.test(mimeType)) {
    try {
      data = forge.util.decodeUtf8(data);

      // trimming bad data at the end the spine
      var lastClosingTagIndex = data.lastIndexOf('>');
      if (lastClosingTagIndex > 0) {
        data = data.substring(0, lastClosingTagIndex + 1);
      }
    } catch (err) {
      console.warn('Can’t decode utf8 content', err);
    }
  }
  return data;
}
