module.exports = {
    apps: [{
        name: 'yjs-server',
        script: './server.js',
        cwd: '/var/www/scriptorium/yjs-server',
        env: {
            PORT: 1889,
            // Loopback only: Caddy reverse-proxies /congruum to this port, so
            // nothing outside the box should reach it directly. ufw also blocks
            // it, but binding narrowly means a firewall change cannot expose it.
            HOST: '127.0.0.1',
            // Point to existing y-leveldb data - NO MIGRATION NEEDED!
            LEVELDB_PATH: '/var/www/congruum/yjs-db.backup',
            // SQLite only for snapshots
            SQLITE_PATH: '/var/www/yjs-server/data/snapshots.db',
            // Credentials are validated by PHP (api/validate.php) rather than
            // by reading token files here, so there is one set of rules.
            VALIDATE_URL: 'http://127.0.0.1/api/validate.php',
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
