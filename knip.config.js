export default {
  entry: ['bin/*.mjs', 'tests/*.test.mjs'],
  project: ['{bin,src,tests}/**/*.mjs', '*.{js,mjs}'],
};
