import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import { productionMaintainabilityRules, testMaintainabilityRules } from '../eslint-maintainability.js'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      ...productionMaintainabilityRules,
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/clipboard.ts", "src/**/*.test.{ts,tsx}"],
    rules: {
      // iOS pastes scheme-led text percent-encoded unless lib/clipboard.ts
      // prepares it first.
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.object.name='navigator'][object.property.name='clipboard'][property.name=/^(writeText|write)$/]",
          message: 'Copy through writeClipboardText in @/lib/clipboard so iOS pastes the text as written.',
        },
      ],
    },
  },
  {
    files: ["src/**/*.test.{ts,tsx}"],
    rules: {
      ...testMaintainabilityRules,
    },
  },
  // vendored shadcn primitives export variant helpers by design
  {
    files: ['src/components/ui/**'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
