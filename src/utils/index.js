import EpubCFI from '../cfi/epubcfi';

import cheerio from 'react-native-cheerio';
import forge from '../../vendor/forge.min';

const UTF8 = 'utf-8';
const UTF16BE = 'utf-16be';
const UTF16LE = 'utf-16le';
const UTF32BE = 'utf-32be';
const UTF32LE = 'utf-32le';

const UTF16BE_BOM_MARKER = '254-255';
const UTF16LE_BOM_MARKER = '255-254';
const UTF32BE_BOM_MARKER = '0-0-254-255';
const UTF32LE_BOM_MARKER = '255-254-0-0';

const TEXT_NODE = 3;

export const EMPTY_ELEMENTS_COUNT = {characterCount: 0, imageCount: 0, videoCount: 0, totalCount: 0};

export function isEmpty(variable) {
  return variable === undefined || variable === null || variable === '' || variable.length === 0;
}

export function parseXml(data) {
  const xmlData = typeof data === 'string' ? data.trim() : bytesToString(data);
  return cheerio.load(xmlData, {xmlMode: true});
}

export function detectCharset(uint8array) {
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

export function normalizePath(path) {
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

export function getOpfFilePath(document) {
  return document('rootfile').attr('full-path');
}

export function getBasePath(contentFilePath) {
  const result = contentFilePath.match(/^(\w*)\/\w*\.opf$/);
  if (result) {
    return result[1] + '/';
  }
  return '';
}

export function getDirPath(fileFullPath) {
  const dirPath = fileFullPath.split('/').slice(0, -1).join('/');
  return isEmpty(dirPath) ? '' : `${dirPath}/`;
}

export function convertUtf16Data(data) {
  // BOM removal
  if (data.charCodeAt(0) === 0xFEFF) {
    data = data.substr(1);
  }
  data = data.replace(/^ï»¿/, '');

  // convert UTF-8 decoded data to UTF-16 javascript string
  try {
    data = forge.util.decodeUtf8(data);
  } catch (err) {
    console.warn('Can’t decode utf8 content', err);
  }

  return data;
}

export function makeAbsolutePath(path) {
  if (path[0] === '/') {
    return path;
  }
  return `/${path}`;
}

export function getSpineElementsCountInDom(domContent) {
  return Promise.all([getCharacterCountInDom(domContent), getImageCountInDom(domContent), getVideoCountInDom(domContent)])
    .then(([characterCount, imageCount, videoCount]) => ({characterCount, imageCount, videoCount}))
    .then(estimateTotalCount)
    .catch(error => {
      console.warn('Content analyze failed', error);
      return EMPTY_ELEMENTS_COUNT;
    });
}

function getElementsCount(elements) {
  return Promise.all([getCharacterCount(elements), getImageCount(elements), getVideoCount(elements)])
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

function estimateTotalCount(elementsCounts) {
  elementsCounts.totalCount = elementsCounts.characterCount + 300 * elementsCounts.imageCount + 300 * elementsCounts.videoCount;
  return elementsCounts;
}

export function bytesToString(uint8array) {
  const charset = detectCharset(uint8array);

  if (typeof TextDecoder === 'undefined') {
    return String.fromCharCode.apply(null, uint8array);
  }

  const textDecoder = new TextDecoder(charset);
  return textDecoder.decode(uint8array);
}

function getHashFromHref(href) {
  const hrefSplit = href.split('#');
  return hrefSplit.length > 1 ? hrefSplit[1] : null;
}

export function enrichTocItems(items, spine, spineDomContent) {
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

export function computeTocItemsSizes(items, basePosition = 0, baseSize = 1) {
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

export function generatePagination(tocItems, spines) {
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

export function extractEncryptionsData(encryptionFile) {
  try {
    const resources = {};
    encryptionFile('EncryptedData').each((index, element) => {
      const uri = encryptionFile('CipherData > CipherReference', element).attr('URI');
      const algorithm = encryptionFile('EncryptionMethod', element).attr('Algorithm');
      const compression = encryptionFile('Compression', element);

      let type = null;
      const retrievalMethod = encryptionFile('KeyInfo > RetrievalMethod', element);
      if (retrievalMethod.length > 0) {
        type = retrievalMethod.attr('Type');
      }
      const keyInfo = encryptionFile('KeyInfo > resource', element);
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

export function fetchAsArrayBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = new XMLHttpRequest();
    req.open('GET', url, true);
    req.responseType = 'arraybuffer';

    req.onload = function() {
      const arrayBuffer = req.response;
      if (arrayBuffer) {
        resolve(arrayBuffer);
      }
    };

    req.onerror = reject;

    req.send(null);
  });
}
