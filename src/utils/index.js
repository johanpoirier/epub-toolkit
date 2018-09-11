function isEmpty(variable) {
  return variable === undefined || variable === null || variable === '' || variable.length === 0;
}

module.exports = {isEmpty};
