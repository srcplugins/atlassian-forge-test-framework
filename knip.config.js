export default {
  entry: ['bin/*.mjs', 'scripts/*.mjs', 'tests/*.test.mjs'],
  project: ['{bin,scripts,src,tests}/**/*.mjs', '*.{js,mjs}'],
};
