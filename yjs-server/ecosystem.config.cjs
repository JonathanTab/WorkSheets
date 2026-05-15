module.exports = {
    apps: [{
        name: 'yjs-server',
        script: './server.js',
        cwd: '/home/isidore/scriptorium/yjs-server',
        env: {
            PORT: 1889,
            HOST: '0.0.0.0',
            // Point to existing y-leveldb data - NO MIGRATION NEEDED!
            LEVELDB_PATH: '/var/www/congruum/yjs-db.backup',
            // SQLite only for snapshots
            SQLITE_PATH: '/var/www/yjs-server/data/snapshots.db',
            TOKEN_DIR: '/var/www/instrumenta/data/session_tokens/',
            GC: 'true',
            SNAPSHOT_MIN_INTERVAL: '600000',
            SNAPSHOT_MAX_INTERVAL: '3600000',
            ALLOW_ANONYMOUS: 'false',
            // Used by storage.php to proxy snapshot API calls
            // Set this in the PHP environment (e.g. apache/nginx SetEnv), not here
            // YJS_SERVER_URL: 'http://localhost:1889'
        }
    }]
};
