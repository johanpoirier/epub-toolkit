export default function () {
  if (Promise) {
    Promise.series = function series(providers) {
      const ret = Promise.resolve(null);
      const results = [];

      return providers.reduce(function(result, provider, index) {
        return result.then(function() {
          return provider().then(function(val) {
            results[index] = val;
          });
        });
      }, ret).then(() => results);
    }
  }
}
