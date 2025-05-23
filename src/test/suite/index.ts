// src/test/suite/index.ts
import * as path from 'path';
import Mocha     from 'mocha';   // default-import now works
import glob      from 'glob';    // ditto

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true });

  const testsRoot = __dirname;
  const files = glob.sync('**/*.test.js', { cwd: testsRoot });

  files.forEach(f => mocha.addFile(path.join(testsRoot, f)));

  return new Promise<void>((resolve, reject) => {
    mocha.run((failures: number | undefined) => {
      failures && failures > 0
        ? reject(new Error(`${failures} tests failed.`))
        : resolve();
    });
  });
}
