const {Explorer} = require('../lib/epub-toolkit');
const fs = require('fs');

const userKeys = ['SOME_KEY'];
const license = JSON.parse('SOME_JSON_LICENSE');

function loadFile(name) {
  return new Promise(resolve => {
    fs.readFile(`${__dirname}/ebooks/${name}`, function (err, data) {
      if (err) {
        throw err;
      }
      resolve(data);
    });
  });
}

loadFile('SOME_FILE.pdf')
  .then(data => Explorer.decipher(data, license, userKeys[0]))
  .then(ebookData => {
    return fs.writeFileSync('deciphered_file.pdf', ebookData);
  });

// loadFile('antechrist.epub')
//   .then(data => Explorer.loadFromBinary(data, null, ))
//   .then(ebook => ebook.analyze())
//   .then(console.log);
