const path = require('path');

module.exports = {
  mode: 'production',
  entry: './src/renderer/index.tsx',
  target: 'electron-renderer',
  output: {
    path: path.resolve(__dirname, 'lib/renderer'),
    filename: 'index.js',
    libraryTarget: 'commonjs2',
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: {
          loader: 'ts-loader',
          options: {
            configFile: 'tsconfig.renderer.json',
          },
        },
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  // Externalize ONLY what Local actually exposes to an add-on's renderer
  // require() path. The bundle is loaded by a plain Node require() from the
  // installed add-on dir (outside Local's app.asar), so any external left in it
  // must resolve there on a CLEAN install. Verified via Local's log on a real
  // .tgz install: Local exposes react + react-dom (and electron is always
  // present), but NOT @getflywheel/local-components and NOT react-router-dom —
  // those must be bundled (handled here for local-components, via
  // context.ReactRouter for the router). react/react-dom stay external so
  // Local's single React instance is used (bundling React → React error #130).
  // @getflywheel/local is type-only in our code (erased at compile → no runtime
  // require). See src/renderer/bundle.packaging.test.ts for the guard.
  externals: {
    react: 'react',
    'react-dom': 'react-dom',
  },
};
