import { terser } from "rollup-plugin-terser";
import { nodeResolve } from "@rollup/plugin-node-resolve";

export default {
    input: "lib/index.js",
    output: [
        {
            file: "dist/fastboot.cjs",
            format: "cjs",
            sourcemap: true,
        },
        {
            file: "dist/fastboot.mjs",
            format: "es",
            sourcemap: true,
        },
        {
            file: "dist/fastboot.min.cjs",
            format: "cjs",
            sourcemap: true,
            plugins: [terser()],
        },
        {
            file: "dist/fastboot.min.mjs",
            format: "es",
            sourcemap: true,
            plugins: [terser()],
        },
    ],
    plugins: [nodeResolve()],
};
