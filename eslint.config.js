import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    // Vite's own config is the one `.js` file here that runs in Node rather than the browser: it reads
    // `process.env` for the build's edition and port (`vite.config.js`). `globals.browser` above is what
    // every other `.js` file in the project needs, so this adds Node's globals for this file only.
    files: ['vite.config.js'],
    languageOptions: { globals: globals.node },
  },
])
