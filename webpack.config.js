var path = require('path');
var webpack = require('webpack');


var UglifyJsPlugin = webpack.optimize.UglifyJsPlugin;
var env = process.env.WEBPACK_ENV;

var libraryName = 'role-hierarchy';
var plugins = [], outputFile;
if (env === 'build') {
  plugins.push(new UglifyJsPlugin({minimize: true}));
  outputFile = libraryName + '.min.js';
} else {
  outputFile = libraryName + '.js';
}


module.exports = {
  entry: {"s3-sts-enabler": './source/s3-sts-enabler.js', test: './test/test.js'},
  devtool: 'source-map',
  output: {
    path: path.resolve(__dirname, 'distribution'),
    filename: '[name].js',
    library: 's3stsenabler',
    // libraryTarget: 'umd',
    // umdNamedDefine: true
  },
  module: {
    // rules: [
    //   {
    //     test: /\.js$/,
    //     exclude: /(node_modules|bower_components)/,
    //     use: {
    //       loader: 'babel-loader',
    //       options: {
    //         presets: ['env']
    //       }
    //     }
    //   }
    // ]
    loaders: [
      {
        test: /\.js$/,
        loader: 'babel-loader',
        exclude: /node_modules/,  // <------ I have forgot it and got "Cannot read property 'crypto' of undefined"
        query: {
          cacheDirectory: true,
          presets: ['env']
        }
      }
    ]
  },
  stats: {
    colors: true
  },
  node: {
    fs: "empty"
  },
  externals: {
    config: {
      commonjs: 'config',
      commonjs2: 'config',
      amd: 'config',
      root: 'config'
    }
  }

};