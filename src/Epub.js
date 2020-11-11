export default class Epub {
  setKeys(keys) {
    this._keys = keys;
  }

  async analyze() {
    return {
      license: await this.license(),
      metadata: await this.metadata(),
      spine: await this.spine(),
      toc: await this.toc()
    };
  }

  async metadata() {
    return this.getMetadata();
  }

  async spine() {
    return this.getSpine();
  }

  async toc() {
    return this.getSpine();
  }

  async license() {
    return this.getLicense();
  }

  async getMetadata() {
    return {};
  }

  async getSpine() {
    return [];
  }

  async getToc() {
    return [];
  }

  async getLicense() {
    return null;
  }
}
