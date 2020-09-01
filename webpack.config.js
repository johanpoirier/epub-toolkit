const libraryName = 'epub-toolkit';
const outputFile = libraryName + '.js';

const config = {
  mode: 'development',
  entry: __dirname + '/index.js',
  devtool: 'source-map',
  output: {
    path: __dirname + '/lib',
    filename: outputFile,
    library: libraryName,
    libraryTarget: 'umd',
    umdNamedDefine: true,
    globalObject: 'this'
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        loader: 'babel-loader',
        exclude: /(node_modules|forge\.toolkit\.js)/,
      }
    ]
  },
  resolve: {
    extensions: ['.js']
  }
};

module.exports = config;
