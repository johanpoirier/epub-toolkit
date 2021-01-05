import {
  EMPTY_ELEMENTS_COUNT,
  enrichTocItems,
  extractEncryptionsData,
  generatePagination,
  getSpineElementsCountInDom,
  parseXml
} from './utils';
import Ebook from './Ebook';
import nextFrame from 'next-frame';

class WebEpub extends Ebook {

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
      try {
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
          this._spine = await Promise.series(items.map(spine => async () => {
            await nextFrame();
            return analyzeSpineItem(spine, this._url, toc);
          }));
        } else {
          this._spine = items;
        }
      } catch(error) {
        console.warn('Error generating spine', error);
        this._spine = [];
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
      try {
        const manifest = await this.manifest();
        const tocItems = manifest['toc'];
        transformTocItems(tocItems, 1, 0);
        this._toc = tocItems;
      } catch(error) {
        console.warn('Error generating toc', error);
        this._toc = [];
      }
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
    try {
      if (await this.isFixedLayout()) {
        return null;
      }
      if (!this._pagination) {
          this._pagination = await generatePagination(await this.getToc(), await this.getSpine());
      }
    } catch(error) {
      console.warn('Error generating pagination', error);
      this._pagination = {
        totalCount: 0,
        maxLevel: 1,
        elements: []
      };
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

function transformTocItems(items, level, endpoints) {
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    item.label = item.title;
    item.level = level;
    item.items = item.children;
    item.endPoint = (!item.items || item.items.length === 0);
    if (item.endPoint) {
      endpoints += 1;
      item.position = endpoints;
    } else {
      endpoints = transformTocItems(item.items, level + 1, endpoints);
    }
    delete item.title;
    delete item.templated;
    delete item.children;
  }
  return endpoints;
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
