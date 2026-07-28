const path = require("node:path");
const Mocha = require("mocha");

function run() {
  const mocha = new Mocha({ ui: "tdd", color: true });
  mocha.addFile(path.join(__dirname, "custom-editor.test.cjs"));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures) reject(new Error(`${failures} VS Code test(s) failed`));
      else resolve();
    });
  });
}

module.exports = { run };
