/**
 * Expo's default Metro config.
 *
 * Present for `babel.config.js`'s reason — hand-scaffolded repository, and the default is what
 * the bundler expects to find.
 */
const { getDefaultConfig } = require('expo/metro-config')

module.exports = getDefaultConfig(__dirname)
