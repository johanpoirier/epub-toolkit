import cheerio from 'cheerio';
import {all} from 'rsvp';
import Lcp from './Lcp';
import {
  isEmpty,
  parseXml,
  makeAbsolutePath,
  generatePagination
} from './utils';
import {
  analyzeSpineItem,
  getCoverPath,
  getFile,
  getLcpLicense,
  getOpfContent,
  getProtectedFiles,
  getZipFileData
} from './utils/zipTools';
import mime from 'mime-types';
import Ebook from './Ebook';
import parseToc from './TocParser';

class ZipEpub extends Ebook {

  constructor(zip, license, keys) {
    super();

    this._zip = zip;
    this._license = license;
    this._keys = keys;
  }

  async getMetadata() {
    if (!this._metadata) {
      this._metadata = await getMetadata(this._zip);
    }
    return this._metadata;
  }

  async getLicense() {
    if (this._license) {
      return this._license;
    }
    return getLcpLicense(this._zip);
  }

  async getSpine() {
    if (this._spine) {
      return this._spine;
    }

    const license = await this.getLicense();
    const toc = await this.getToc();

    // finding spines in .opf
    const {basePath, opf} = await getOpfContent(this._zip);
    const validSpineItems = [];
    opf('spine > itemref').each((index, element) => {
      const spineItem = cheerio(element);
      const idref = spineItem.attr('idref');
      const item = opf(`manifest > item[id="${idref}"]`);
      if (isEmpty(item)) {
        return;
      }
      const href = item.attr('href');
      const validSpineItem = {
        idref,
        href,
        path: makeAbsolutePath(`${basePath}${href}`)
      };

      const spineProperties = spineItem.attr('properties');
      if (!isEmpty(spineProperties)) {
        validSpineItem.spread = spineProperties;
      }

      validSpineItems.push(validSpineItem);
    });

    const protectedFiles = await this.getProtectedFiles(this._zip);
    validSpineItems.forEach((item, index) => {
      item.cfi = `/6/${2 + index * 2}`;
      item.protection = protectedFiles[item.path];
    });

    if (!isEpubFixedLayout((await this.getMetadata()))) {
      const userKey = await Lcp.getValidUserKey(license, this._keys);
      this._spine = await all(validSpineItems.map(spine => analyzeSpineItem.call(this, this._zip, spine, license, userKey, toc)), 'spine analysis');
    } else {
      this._spine = validSpineItems;
    }

    return this._spine;
  }

  async getToc() {
    if (this._toc) {
      return this._toc;
    }

    try {
      const {basePath, opf} = await getOpfContent(this._zip);

      let tocElement = opf('item[media-type="application/x-dtbncx+xml"]'); // epub 2
      if (isEmpty(tocElement)) {
        tocElement = opf('item[properties="nav"]'); // epub 3
      }
      if (isEmpty(tocElement)) {
        return null;
      }

      const tocFilename = tocElement.attr('href');
      const tocFile = await getFile(this._zip, basePath + tocFilename);
      this._toc = parseToc(basePath, parseXml(tocFile));
      return this._toc;
    } catch (error) {
      console.warn('failed to parse toc file', error);
      return null;
    }
  }

  async getPagination() {
    if (await this.isFixedLayout()) {
      return null;
    }
    if (!this._pagination) {
      this._pagination = await generatePagination(await this.getToc(), await this.getSpine());
    }
    return this._pagination;
  }

  async isFixedLayout() {
    const metadata = await this.getMetadata();
    return isEpubFixedLayout(metadata);
  }

  getCoverPath() {
    return getCoverPath(this._zip);
  }

  async getProtectedFiles() {
    if (!this.protectedFiles) {
      this.protectedFiles = await getProtectedFiles(this._zip);
    }
    return this.protectedFiles;
  }

  async getUid() {
    if (this.uid === null) {
      const metadata = await getMetadata(this._zip);
      this.uid = metadata['dc:identifier'] || 0;
    }
    return this.uid;
  }

  async getFileProtection(path) {
    const protections = await getProtectedFiles(this._zip);
    return protections[path];
  }

  async getFile(path) {
    const zipFile = this._zip.file(path);
    if (!zipFile) {
      return;
    }

    const contentType = mime.contentType(path.split('/').pop());
    const userKey = await Lcp.getValidUserKey(this._license, this._keys);

    return {
      data: await getZipFileData(zipFile, contentType, await this.getFileProtection(path), this.license, userKey),
      contentType
    };
  }
}

export default ZipEpub;

function getMetadata(zip) {
  return getOpfContent(zip)
    .then(({opf}) => {
      const fixedMetadata = {};
      const metadata = opf('metadata > *');
      const uniqueIdentifier = opf('package').attr('unique-identifier');

      metadata.each((index, entry) => {
        const data = extractMetadataEntry(entry);
        if (fixedMetadata[data.key] && data.key === 'dc:identifier' && entry.attribs['id'] !== uniqueIdentifier) {
          return;
        }
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

function isEpubFixedLayout(meta) {
  if (!meta) {
    return false;
  }

  const formatData = meta['rendition:layout'];
  return formatData && formatData === 'pre-paginated';
}
