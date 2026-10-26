// Module rules for `npm run debt`, which counts the violations against debt-baseline.json.
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment: "Modules that import each other, directly or through others",
      severity: "error",
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    webpackConfig: { fileName: ".dependency-cruiser.resolve.cjs" },
    tsPreCompilationDeps: true,
  },
};
