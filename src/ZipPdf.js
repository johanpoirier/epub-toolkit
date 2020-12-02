import {
  getLcpLicense, getProtectedFiles,
  getZipFileData
} from './utils/zipTools';
import Ebook from './Ebook';
import Lcp from './Lcp';

class ZipPdf extends Ebook {
  constructor(zip, license, keys) {
    super();

    this._zip = zip;
    this._license = license;
    this._keys = keys;
  }

  async getLicense() {
    if (this._license) {
      return this._license;
    }
    return getLcpLicense(this._zip);
  }

  async isFixedLayout() {
    return true;
  }

  async getFileProtection(path) {
    const protections = await getProtectedFiles(this._zip);
    return protections[path];
  }

  async getPdf() {
    const zipFiles = this._zip.file(/\.pdf$/);
    if (!zipFiles || zipFiles.length === 0) {
      return;
    }
    const zipFile = zipFiles[0];

    const contentType = 'application/pdf';
    const userKey = await Lcp.getValidUserKey(this._license, this._keys);

    return {
      data: await getZipFileData(zipFile, contentType, await this.getFileProtection(`/${zipFile.name}`), this._license, userKey),
      contentType
    };
  }
}

export default ZipPdf;
