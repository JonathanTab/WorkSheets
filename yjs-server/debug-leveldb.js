#!/usr/bin/env node
import { Level } from 'level';

const db = new Level('/var/www/congruum/yjs-db.backup', { valueEncoding: 'buffer' });

let count = 0;
for await (const [key, value] of db.iterator()) {
    console.log('Key:', key.toString(), 'Len:', value.length);
    console.log('Key bytes:', [...key.slice(0, 20)]);
    count++;
    if (count > 10) break;
}

console.log('Total seen:', count);
