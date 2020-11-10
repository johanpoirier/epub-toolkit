import {FileNotFoundError} from '../errors';
import {hash} from 'rsvp';
import {
  convertUtf16Data, EMPTY_ELEMENTS_COUNT, enrichTocItems,
  getBasePath,
  getOpfFilePath,
  getSpineElementsCountInDom,
  isEmpty,
  normalizePath,
  parseXml
} from './index';
import Lcp, {PROTECTION_METHODS} from '../Lcp';

export const BYTES_FORMAT = 'uint8array';
export const STRING_FORMAT = 'string';
export const ARRAYBUFFER_FORMAT = 'arraybuffer';

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
    .then(opfXml => {
      return hash({
        basePath: basePath,
        opf: parseXml(opfXml.trim())
      });
    });
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
