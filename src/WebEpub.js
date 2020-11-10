import {all} from 'rsvp';
import {
  EMPTY_ELEMENTS_COUNT,
  enrichTocItems,
  getSpineElementsCountInDom,
  isEmpty,
  isEpubFixedLayout,
  parseXml
} from './utils';
import Epub from './Epub';
import Lcp from "./Lcp";

class WebEpub extends Epub {

  constructor(url, license, keys) {
    super();

    this._url = url;
    this._license = license;
    this._keys = keys;
  }

  /**
   *
   */
  async manifest() {
    if (this._manifest !== null) {
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
    const manifest = await this.manifest();
    const shouldAnalyzeSpines = isEpubFixedLayout(manifest.metadata.meta);

    const items = manifest['readingOrder'];
    items.forEach((spine, index) => {
      spine.cfi = `/6/${2 + index * 2}`;
      spine.path = makeAbsolutePath(`${this._url}${spine.href}`);
    });

    if (shouldAnalyzeSpines) {
      const license = await this.getLicense();
      const toc = await this.getToc();
      const userKey = await Lcp.getValidUserKey(license, this._keys);
      return all(items.map(spine => analyzeSpine(spine, this._url, license, userKey, toc)), 'spines');
    }
    return items;
  }

  /**
   * Get Table of Content from the epub web publication
   *
   * @returns {Promise<Array>}
   */
  async getToc() {
    const manifest = await this.manifest();
    const tocItems = manifest['toc'];
    setPositions(tocItems, 1, 0);
    return tocItems;
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
      return fetch(`${this._url}/META-INF/license.lcpl`).then(response => response.json());
    } catch (error) {
      // no license file
      return null;
    }
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

  pagination(tocItems, spines) {
    return generatePagination(tocItems, spines);
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

function analyzeSpine(spine, baseUri, license, userKey, toc) {
  return fetch(`${baseUri}/${spine.href}`)
    .then(response => response.text())
    .then(parseXml)
    .then(domContent => getSpineElementsCountInDom(domContent)
        .then(elementsCount => Object.assign(spine, elementsCount))
        .then(spine => enrichTocItems(toc, spine, domContent))
    )
    .catch(() => {
      console.warn(`Can’t analyze spine ${spine.path}`);
      return Object.assign(spine, EMPTY_ELEMENTS_COUNT);
    });
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
