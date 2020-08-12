const cheerio = require('cheerio');
const {resolve} = require('rsvp');

const UTF8 = 'utf-8';
const UTF16BE = 'utf-16be';
const UTF16LE = 'utf-16le';
const UTF32BE = 'utf-32be';
const UTF32LE = 'utf-32le';

const UTF16BE_BOM_MARKER = '254-255';
const UTF16LE_BOM_MARKER = '255-254';
const UTF32BE_BOM_MARKER = '0-0-254-255';
const UTF32LE_BOM_MARKER = '255-254-0-0';

export function isEmpty(variable) {
  return variable === undefined || variable === null || variable === '' || variable.length === 0;
}

export function parseXml(data) {
  const xmlData = typeof data === 'string' ? data.trim() : bytesToString(data);
  return resolve(cheerio.load(xmlData, {xmlMode: true}));
}

export function bytesToString(uint8array) {
  const charset = detectCharset(uint8array);

  if (typeof TextDecoder === 'undefined') {
    return String.fromCharCode.apply(null, uint8array);
  }

  const textDecoder = new TextDecoder(charset);
  return textDecoder.decode(uint8array);
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
