import { terser } from "rollup-plugin-terser";
import { nodeResolve } from "@rollup/plugin-node-resolve";

export default {
    input: "lib/index.js",
    output: [
        {
            file: "dist/fastboot.cjs",
            format: "cjs",
        },
        {
            file: "dist/fastboot.js",
            format: "es",
        },
        {
            file: "dist/fastboot.min.cjs",
            format: "cjs",
            plugins: [terser()],
        },
        {
            file: "dist/fastboot.min.js",
            format: "es",
            plugins: [terser()],
        },
    ],
    plugins: [nodeResolve()],
};
