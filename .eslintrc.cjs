/**
 * ESLint config — TechRepair Pro
 *
 * Filosofía:
 *   ERROR   = causa bugs en runtime o produce código roto.
 *   WARNING = deuda técnica que debe reducirse, pero no bloquea el trabajo.
 *   OFF     = regla no aplicable o demasiado ruidosa para esta codebase.
 *
 * Para correr:
 *   npm run lint          → reporte completo
 *   npm run lint:errors   → solo errores reales
 *   npm run lint:fix      → auto-fix donde sea posible
 */

/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  env: { browser: true, es2020: true },

  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
    // project no configurado intencionalmente:
    // las reglas type-aware son más lentas y se pueden agregar después
  },

  plugins: [
    '@typescript-eslint',
    'react-hooks',
  ],

  // Sin extends — control total sobre qué reglas están activas
  extends: [],

  rules: {

    // ── React Hooks ── solo las dos clásicas (v4 comportamiento) ─────────────
    // React-hooks v7 agrega reglas del Compiler (React 19) que dan falsos
    // positivos con React 18. Las especificamos manualmente.
    'react-hooks/rules-of-hooks':  'warn',    // no usar hooks condicionalmente
    'react-hooks/exhaustive-deps': 'warn',    // deps de useEffect/useCallback

    // ── Errores básicos JS ─────────────────────────────────────────────────────
    'no-debugger':          'error',
    'no-duplicate-imports': 'error',
    'no-extra-semi':        'warn',
    'eqeqeq':               ['warn', 'smart'],     // preferir === (warn, no error)
    'no-async-promise-executor': 'error',           // no async en new Promise()
    'no-self-assign':       'error',
    'no-undef':             'off',          // TypeScript lo cubre mejor

    // ── console ── solo alertar en producción ─────────────────────────────────
    // warn en dev es OK; eliminamos en producción via logger
    'no-console':   ['warn', { allow: ['warn', 'error', 'debug', 'info'] }],

    // ── TypeScript — reglas clave sin type-checking ───────────────────────────
    '@typescript-eslint/no-explicit-any':       'warn',   // preferir tipos reales
    '@typescript-eslint/no-unused-vars': ['warn', {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      ignoreRestSiblings: true,
      caughtErrors: 'none',
    }],
    '@typescript-eslint/ban-ts-comment':        'warn',
    '@typescript-eslint/no-empty-function':     'off',   // funciones vacías son OK
    '@typescript-eslint/no-empty-object-type':  'warn',
    '@typescript-eslint/no-require-imports':    'error',
    '@typescript-eslint/no-non-null-assertion': 'off',   // usamos ! en varios lugares válidos

    // Estas reglas necesitan `project` configurado — off por ahora
    '@typescript-eslint/no-floating-promises':     'off',
    '@typescript-eslint/no-misused-promises':      'off',
    '@typescript-eslint/await-thenable':           'off',
    '@typescript-eslint/no-unsafe-assignment':     'off',
    '@typescript-eslint/no-unsafe-member-access':  'off',
    '@typescript-eslint/no-unsafe-call':           'off',
    '@typescript-eslint/no-unsafe-return':         'off',
    '@typescript-eslint/no-unsafe-argument':       'off',

    // ── prefer-const ─────────────────────────────────────────────────────────
    'prefer-const': ['warn', { destructuring: 'all' }],
  },

  ignorePatterns: [
    'dist/',
    'node_modules/',
    'vite.config.ts',
  ],
}
