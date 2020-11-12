export default class Epub {
  setKeys(keys) {
    this._keys = keys;
  }

  async analyze() {
    const spine = await this.spine();
    return {
      license: await this.license(),
      metadata: await this.metadata(),
      spine,
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
    return this.getToc();
  }

  async license() {
    return this.getLicense();
  }

  async pagination() {
    return this.getPagination();
  }

  async isFixedLayout() {
    return false;
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

  async getPagination() {
    return null;
  }
}
