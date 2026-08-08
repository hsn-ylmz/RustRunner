const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

const isProduction = process.env.NODE_ENV === 'production';

// webpack-dev-server injects its client code inline, which needs
// 'unsafe-inline'. Packaged builds load a static bundle and must not.
const CSP = isProduction
  ? "script-src 'self'"
  : "script-src 'self' 'unsafe-inline'";

module.exports = {
  mode: isProduction ? 'production' : 'development',
  entry: './src/renderer/index.tsx',
  // 'web', not 'electron-renderer'. The renderer runs contextIsolated with
  // nodeIntegration off (Electron's defaults; main.ts sets only `preload`), so
  // there is no `global`, no `require`, and no Node builtins in the page.
  // Under 'electron-renderer' webpack assumed otherwise and emitted a HMR
  // runtime referencing `global`, which threw before React could mount and
  // left the window blank. All privileged access goes through the preload
  // bridge on `window.electron` instead.
  target: 'web',
  devtool: 'source-map',
  output: {
    path: path.resolve(__dirname, 'dist/renderer'),
    filename: 'bundle.js',
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
            transpileOnly: true,
            compilerOptions: {
              noEmit: false,
            },
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
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/renderer/index.html',
      templateParameters: { csp: CSP },
    }),
  ],
  devServer: {
    static: {
      directory: path.join(__dirname, 'dist/renderer'),
    },
    port: 3000,
    hot: true,
  },
};
