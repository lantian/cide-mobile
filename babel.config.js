/**
 * Expo's preset, and nothing else.
 *
 * Written by hand because this repository was scaffolded by hand rather than by
 * `create-expo-app`, and its absence is not a nice error: the native build gets all the way to
 * bundling and then fails inside Metro's config loader.
 */
module.exports = function (api) {
  api.cache(true)
  return { presets: ['babel-preset-expo'] }
}
