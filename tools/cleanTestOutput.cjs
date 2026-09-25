const { rmSync } = require('node:fs');
const { resolve } = require('node:path');

rmSync(resolve(process.cwd(), 'out', 'test'), { recursive: true, force: true });
