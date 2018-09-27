const {resolve} = require('rsvp');

class WebEpub {
  constructor(url) {
    this._url = url;
    this._manifest = null;
  }

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

  metadata() {
    return this.manifest().then(manifest => manifest.metadata);
  }

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
}

module.exports = WebEpub;

function getCoverPathFromMetadata(resources) {
  const coverPaths = resources.filter(entry => entry.rel && entry.rel.includes('cover')).map(res => res.href);
  return coverPaths.pop();
}

function getCoverPathFromResources(resources) {
  const imagePaths = resources.filter(resource => resource.type.indexOf('image/') === 0).map(res => res.href);
  const coverPaths = imagePaths.filter(path => path.indexOf('cover') !== -1);
  return coverPaths.pop();
}
