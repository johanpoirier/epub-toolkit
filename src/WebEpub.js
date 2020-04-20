import {resolve, all} from 'rsvp';
import {isEmpty, parseXml} from './utils';

const EMPTY_ELEMENTS_COUNT = {characterCount: 0, imageCount: 0, videoCount: 0, totalCount: 0};

const TEXT_NODE = 3;

class WebEpub {

  constructor(url) {
    this._url = url;
    this._manifest = null;
  }

  /**
   *
   */
  manifest() {
    if (this._manifest !== null) {
      return resolve(this._manifest);
    }
    return fetch(`${this._url}/manifest.json`)
      .then(response => response.json())
      .then(manifestJson => {
        this._manifest = manifestJson;
        return this._manifest;
      });
  }

  /**
   *
   * @returns {Promise} A promise that resolves with the metadata of the epub
   */
  metadata() {
    return this.manifest().then(manifest => manifest.metadata);
  }

  /**
   *
   * @return {Promise} A promise that resolves with the relative path of the cover file
   */
  coverPath() {
    return this.manifest()
      .then(manifest => {
        let coverResource = getCoverPathFromMetadata(manifest['resources']);
        if (!coverResource) {
          coverResource = getCoverPathFromResources(manifest['resources']);
        }
        return coverResource;
      });
  }

  /**
   * Get spines from the epub web publication
   *
   * @return {Promise} A promise that resolves with an array of each spine character count
   */
  spines() {
    return this.manifest()
      .then(manifest => getSpines(manifest['spine'], this._url));
  }

  /**
   * Get Table of Content from the epub web publication
   *
   * @return {Promise} A promise that resolves with the table of content
   */
  toc() {
    return this.manifest()
      .then(manifest => {
        const tocItems = manifest['toc'];
        setPositions(tocItems, 1, 0);
        return tocItems;
      });
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

function getSpines(spines, baseUri) {
  for (let spineIndex = 0; spineIndex < spines.length; spineIndex++) {
    spines[spineIndex].cfi = `/4/${2 + spineIndex * 2}`;
  }

  const promises = [];
  spines.forEach(spine => promises.push(analyzeSpine(spine, baseUri)));
  return all(promises);
}

function analyzeSpine(spine, baseUri) {
  return fetch(`${baseUri}/${spine.href}`)
    .then(response => response.text())
    .then(parseXml)
    .then(domContent => getSpineElementsCountInDom(domContent)
      .then(elementsCount => Object.assign(spine, elementsCount))
      //.then(spine => enrichTocItems(toc, spine, domContent))
    )
    .catch(() => {
      console.warn(`Can’t analyze spine ${spine.path}`);
      return Object.assign(spine, EMPTY_ELEMENTS_COUNT);
    });
}

function getSpineElementsCountInDom(domContent) {
  return all([getCharacterCountInDom(domContent), getImageCountInDom(domContent), getVideoCountInDom(domContent)])
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

function getVideoCountInDom(domContent) {
  const elements = domContent('video');
  return elements.length;
}

function estimateTotalCount(elementsCounts) {
  elementsCounts.totalCount = elementsCounts.characterCount + 300 * elementsCounts.imageCount + 300 * elementsCounts.videoCount;
  return elementsCounts;
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
