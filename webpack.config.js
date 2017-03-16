var webpack = require('webpack');


module.exports = {
  output: {
    library: 'channels-api',
    libraryTarget: 'umd',
    path: './dist',
    filename: 'channels-api.js'
  },
  entry: {
    library: './index'
  },
  module: {
    loaders: [{
      test: /\.js$/,
      loaders: ['babel-loader'],
    }]
  },
  plugins: [
    new webpack.DefinePlugin({
      'process.env': {
        'NODE_ENV': JSON.stringify('production')
      }
    }),
    new webpack.optimize.UglifyJsPlugin({
      compressor: {
        warnings: false
      },
      output: {
        comments: false
      }
    })
  ],
};
