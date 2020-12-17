import commonjs from '@rollup/plugin-commonjs';
import nodeResolve from '@rollup/plugin-node-resolve';
import json from '@rollup/plugin-json';

export default {
  input: 'src/index.js',
  output: {
    format: 'cjs',
    file: 'lib/index.js'
  },
  external: [
    'jszip',
    'mime',
    'pako',
    'react-native-cheerio'
  ],
  plugins: [
    commonjs(),
    nodeResolve({
      browser: true,
      jsnext: true,
      main: true,
      preferBuiltins: false
    }),
    json()
  ]
};
