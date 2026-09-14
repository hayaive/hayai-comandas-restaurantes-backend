/**
 * `package.json` ya traía el script `lint` y las dependencias de ESLint
 * (@typescript-eslint, eslint-config-prettier), pero el archivo de
 * configuración nunca se commiteó: `npm run lint` fallaba con "couldn't find a
 * configuration file" en cualquier árbol, limpio o sucio.
 *
 * Esta es la configuración estándar que genera el CLI de Nest para esas mismas
 * dependencias. `src/generated` queda fuera: es el cliente de Prisma generado,
 * no código del proyecto.
 */
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.eslint.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: ['plugin:@typescript-eslint/recommended', 'prettier'],
  root: true,
  env: { node: true, jest: true },
  ignorePatterns: ['.eslintrc.js', 'dist', 'src/generated'],
  rules: {
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    // Las filas de `$queryRaw` sobre vistas no tienen tipo generado por
    // Prisma: se anotan `any[]` a propósito.
    '@typescript-eslint/no-explicit-any': 'off',
    // `const { claveHash: _claveHash, ...resto } = usuario` es la forma de
    // quitar un hash de la respuesta. La variable no se usa: ese es el punto.
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
  },
};
