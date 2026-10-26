// How dependency-cruiser resolves the pages' imports: by their served paths ("/app.js"), from web/.
const { resolve } = require("node:path");

module.exports = { resolve: { roots: [resolve(__dirname, "web")] } };
