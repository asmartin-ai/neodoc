
import { bundle } from './tools/bundle.js';
import { writeFileSync } from 'node:fs';
const html = bundle();
writeFileSync('/tmp/neodoc-editor-built.html', html);
console.log('built', html.length, 'bytes');
