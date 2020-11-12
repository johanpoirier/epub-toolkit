import {all} from 'rsvp';
import {
  convertUtf16Data,
  EMPTY_ELEMENTS_COUNT,
  enrichTocItems,
  extractEncryptionsData,
  fetchAsArrayBuffer,
  getSpineElementsCountInDom,
  isEmpty,
  parseXml
} from './utils';
import Epub from './Epub';
import Lcp, {PROTECTION_METHODS} from './Lcp';

class WebEpub extends Epub {

  constructor(url) {
    super();
    this._url = url;
  }

  /**
   *
   */
  async manifest() {
    if (this._manifest !== undefined) {
      return this._manifest;
    }
    this._manifest = await fetch(`${this._url}/manifest.json`).then(response => response.json());
    return this._manifest;
  }

  /**
   *
   * @returns {Promise} A promise that resolves with the metadata of the epub
   */
  async getMetadata() {
    const manifest = await this.manifest();
    return manifest.metadata;
  }

  /**
   * Get spine from the epub web publication
   *
   * @return {Promise} A promise that resolves with an array of each spine character count
   */
  async getSpine() {
    if (!this._spine) {
      const manifest = await this.manifest();
      const items = manifest['readingOrder'];

      const protectedFiles = await getProtectedFiles(this._url);
      items.forEach((item, index) => {
        item.cfi = `/6/${2 + index * 2}`;
        item.path = makeAbsolutePath(item.href);
        item.protection = protectedFiles[item.path];
      });

      if (!isEpubFixedLayout(manifest.metadata)) {
        const toc = await this.getToc();
        this._spine = await all(items.map(spine => analyzeSpineItem(spine, this._url, toc)), 'spines');
      } else {
        this._spine = items;
      }
    }

    return this._spine;
  }

  /**
   * Get Table of Content from the epub web publication
   *
   * @returns {Promise<Array>}
   */
  async getToc() {
    if (!this._toc) {
      const manifest = await this.manifest();
      const tocItems = manifest['toc'];
      this._toc = setPositions(tocItems, 1, 0);
    }
    return this._toc;
  }

  /**
   * Get the LCP license of the web publication
   *
   * @returns {Promise<string | null>}
   */
  async getLicense() {
    if (this._license) {
      return this._license;
    }
    try {
      const response = await fetch(`${this._url}/META-INF/license.lcpl`);
      if (response.ok) {
        const license = await response.json();
        if (license.success === undefined || license.success !== false) {
          return license;
        }
      }
    } catch (error) {
      // no license file
    }
    return null;
  }

  /**
   *
   * @returns {{totalCount, maxLevel, elements}}
   */
  async getPagination() {
    if (await this.isFixedLayout()) {
      return null;
    }
    if (!this._pagination) {
      this._pagination = await generatePagination(await this.getToc(), await this.getSpine());
    }
    return this._pagination;
  }

  /**
   *
   * @returns {Promise<boolean>}
   */
  async isFixedLayout() {
    const metadata = await this.getMetadata();
    return isEpubFixedLayout(metadata);
  }

  /**
   *
   * @return {Promise} A promise that resolves with the relative path of the cover file
   */
  async coverPath() {
    const manifest = await this.manifest();
    let coverResource = getCoverPathFromMetadata(manifest['resources']);
    if (!coverResource) {
      coverResource = getCoverPathFromResources(manifest['resources']);
    }
    return coverResource;
  }
}

export default WebEpub;


function getCoverPathFromMetadata(resources) {
  const coverPaths = resources.filter(entry => entry.rel && entry.rel.includes('cover')).map(res => res.href);
  return coverPaths.pop();
}

function getCoverPathFromResources(resources) {
  const imagePaths = resources.filter(resource => resource.type.indexOf('image/') === 0).map(res => res.href);
  const coverPaths = imagePaths.filter(path => path.indexOf('cover') !== -1);
  return coverPaths.pop();
}

function makeAbsolutePath(path) {
  if (path[0] === '/') {
    return path;
  }
  return `/${path}`;
}

async function analyzeSpineItem(spineItem, baseUri, toc) {
  try {
    const domContent = parseXml(await getFileContent(baseUri, spineItem.path));
    const elementsCount = await getSpineElementsCountInDom(domContent);
    const analyzedSpineItem = Object.assign(spineItem, elementsCount);
    enrichTocItems(toc, analyzedSpineItem, domContent);
    return analyzedSpineItem;
  } catch(error) {
    console.warn(`Can’t analyze spine item ${spineItem.path}`);
    return Object.assign(spineItem, EMPTY_ELEMENTS_COUNT);
  }
}

function setPositions(items, level, endpoints) {
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    item.level = level;
    item.endPoint = (!item.children || item.children.length === 0);
    if (item.endPoint) {
      endpoints += 1;
      item.position = endpoints;
    } else {
      endpoints = setPositions(item.children, level + 1, endpoints);
    }
  }
  return endpoints;
}

function generatePagination(tocItems, spines) {
  const totalCount = spines.reduce((total, spine) => total + spine.totalCount, 0);

  const elements = [];
  let spineIndex = 0, combinedSize = 0, maxLevel = 1;

  while (spineIndex < spines.length) {
    const spine = spines[spineIndex];
    const items = findTocItemsInSpine(tocItems, spine.href);
    maxLevel = items.reduce((max, item) => item.level > max ? item.level : max, maxLevel);

    let title;
    if (isEmpty(items)) {
      title = isEmpty(elements) ? spine.href.split('.')[0] : elements[spineIndex - 1].title;
    } else {
      title = items[0].title;
    }

    const element = {
      items,
      title: title.trim(),
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

function findTocItemsInSpine(items, href) {
  items = items || [];
  let matchingItems = items.filter(item => item.href.indexOf(href) === 0);
  items.forEach(item => {
    matchingItems = matchingItems.concat(findTocItemsInSpine(item.children, href))
  });
  return matchingItems;
}

function isEpubFixedLayout(metadata) {
  return metadata.presentation.layout === 'fixed';
}


async function getProtectedFiles(baseUrl) {
  try {
    const xmlData = await getFileContent(baseUrl, '/META-INF/encryption.xml');
    const encryptionFile = parseXml(xmlData);

    return extractEncryptionsData(encryptionFile);
  } catch (error) {
    return {};
  }
}

async function getFileContent(baseUrl, path) {
  const fileUrl = `${baseUrl}${path}`;

  try {
    const response = await fetch(fileUrl);
    if (!response.ok) {
      return '';
    }

    return response.text();
  } catch (error) {
    console.warn(`Can’t extract content of file at ${path}`, error);
    return '';
  }
}
