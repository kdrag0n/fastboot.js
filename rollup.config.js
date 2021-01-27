import nodeResolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import { terser } from 'rollup-plugin-terser';

export default {
  input: 'src/index.ts',
  output: [
    {
      file: 'lib/fastboot.cjs',
      format: 'cjs',
    },
    {
      file: 'lib/fastboot.js',
      format: 'es',
    },
    {
      file: 'lib/fastboot.min.cjs',
      format: 'cjs',
      plugins: [terser()],
    },
    {
      file: 'lib/fastboot.min.js',
      format: 'es',
      plugins: [terser()],
    },
  ],
  plugins: [nodeResolve(), typescript({ module: 'ESNext' })],
};
