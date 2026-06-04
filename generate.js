require("dotenv").config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const { spawnSync } = require("child_process");
const path = require("path");

const company = process.env.COMPANY || process.argv[2];
if (!company) {
  console.error("Usage: node generate.js 'IKEA'  OR  COMPANY='IKEA' node generate.js");
  process.exit(1);
}

function run(script) {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, script)], {
    env: { ...process.env, COMPANY: company },
    stdio: "inherit"
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`\n🚀 Account intelligence pipeline: ${company}\n`);
run("generate-content.js");
run("build-html.js");
console.log(`\n🎯 Done: reports/${company.toLowerCase().replace(/[^a-z0-9]/g, "_")}.html`);
